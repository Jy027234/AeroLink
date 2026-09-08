import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import {
  hasCapability,
  type CapabilityActor,
} from '../../lib/capabilityPolicy.js';
import { assertSupportedSaleType } from '../../lib/commercialScope.js';
import {
  assertLineCostSnapshot,
  buildCommercialApprovalSnapshot,
  hashCommercialApprovalSnapshot,
  isLinePartAllowed,
} from '../../lib/lineQuotationPolicy.js';
import {
  assertQuotationValidity,
  buildQuotationApprovalSnapshot,
  QUOTATION_APPROVAL_POLICY_VERSION,
  assertUsdQuotationCurrency,
} from '../../lib/quotationApprovalPolicy.js';
import { assertActiveQuotationRevision } from '../../lib/quotationRevisionPolicy.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { allocationQuantities } from './allocationQuantities.js';
import { assertInventoryUseAllowed } from './returnGuards.js';
import { lockPurchaseCoverageLines, assertAdditionalStockCoverage } from '../procurementSettlement/purchaseCoverage.js';

/**
 * D12's allocation service is intentionally separate from the legacy
 * inventory service.  A modern quotation line owns the commercial demand and
 * an allocation owns an immutable inventory reservation.  Order assignments
 * only split that reservation; they never change physical stock a second
 * time.
 */

type Tx = Prisma.TransactionClient;

export type AllocationInput = {
  inventoryDetailId: string;
  quantity: number;
};

export type AssignmentInput = {
  allocationId: string;
  quantity: number;
};

export type AllocationActor = CapabilityActor;

export type AllocationSafeAssignment = {
  id: string;
  orderLineId: string;
  assignedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
  activeQuantity: number;
};

export type AllocationSafeView = {
  id: string;
  quotationLineId: string;
  inventoryDetailId: string;
  allocatedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
  activeQuantity: number;
  unassignedQuantity: number;
  assignedActiveQuantity: number;
  expiresAt: Date | null;
  assignments: AllocationSafeAssignment[];
};

export type LineInventoryAvailability = {
  quotationLineId: string;
  quantity: number;
  acceptedQuantity: number;
  reservedQuantity: number;
  unassignedQuantity: number;
  assignedActiveQuantity: number;
  activeQuantity: number;
  allocations: AllocationSafeView[];
};

const RESERVABLE_QUOTATION_STATUSES = new Set(['APPROVED', 'SENT', 'ACCEPTED']);
const ACTIVE_ORDER_STATUSES = new Set(['SO_CREATED', 'PO_CREATED']);
const CLOSED_ORDER_STATUSES = new Set(['CANCELLED', 'COMPLETED', 'DELIVERED', 'SHIPPED', 'IN_TRANSIT']);
const SOURCE_TYPES = new Set(['OWN']);

function fail(message: string, code: ConstructorParameters<typeof AppError>[2] = 'RESOURCE_CONFLICT'): never {
  const status = code === 'AUTH_FORBIDDEN' ? 403 : code === 'VALIDATION_ERROR' || code === 'BAD_REQUEST' ? 400 : code === 'RESOURCE_NOT_FOUND' ? 404 : 409;
  throw new AppError(message, status, code);
}

function assertPositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label}必须是正整数`, 'VALIDATION_ERROR');
  }
}

function assertId(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}不能为空`, 'VALIDATION_ERROR');
  return value.trim();
}

function normalizeAllocations(input: readonly AllocationInput[]) {
  if (!Array.isArray(input) || input.length === 0) fail('allocations不能为空', 'VALIDATION_ERROR');
  const normalized = input.map((item, index) => {
    if (!item || typeof item !== 'object') fail(`allocations[${index}]无效`, 'VALIDATION_ERROR');
    const inventoryDetailId = assertId(item.inventoryDetailId, `allocations[${index}].inventoryDetailId`);
    assertPositiveInteger(item.quantity, `allocations[${index}].quantity`);
    return { inventoryDetailId, quantity: item.quantity };
  });
  const ids = new Set<string>();
  for (const item of normalized) {
    if (ids.has(item.inventoryDetailId)) fail('同一命令不能重复指定库存明细', 'VALIDATION_ERROR');
    ids.add(item.inventoryDetailId);
  }
  return normalized.sort((left, right) => left.inventoryDetailId.localeCompare(right.inventoryDetailId));
}

function normalizeAssignmentInputs(input: readonly AssignmentInput[]) {
  if (!Array.isArray(input) || input.length === 0) fail('allocations不能为空', 'VALIDATION_ERROR');
  const normalized = input.map((item, index) => {
    if (!item || typeof item !== 'object') fail(`allocations[${index}]无效`, 'VALIDATION_ERROR');
    const allocationId = assertId(item.allocationId, `allocations[${index}].allocationId`);
    assertPositiveInteger(item.quantity, `allocations[${index}].quantity`);
    return { allocationId, quantity: item.quantity };
  });
  const ids = new Set<string>();
  for (const item of normalized) {
    if (ids.has(item.allocationId)) fail('同一命令不能重复指定父分配', 'VALIDATION_ERROR');
    ids.add(item.allocationId);
  }
  return normalized.sort((left, right) => left.allocationId.localeCompare(right.allocationId));
}

function assertInventoryManager(actor: AllocationActor) {
  if (!hasCapability(actor, 'inventory', 'manage')) {
    fail('当前角色无权管理库存分配', 'AUTH_FORBIDDEN');
  }
}

function assertQuoteRead(actor: AllocationActor, quotation: { createdBy: string; creator: { department: string | null } }) {
  if (!hasCapability(actor, 'quotation', 'read', {
    ownerId: quotation.createdBy,
    department: quotation.creator.department,
  })) {
    fail('当前角色无权读取报价范围', 'AUTH_FORBIDDEN');
  }
}

function assertOrderRead(actor: AllocationActor, quotation: { createdBy: string; creator: { department: string | null } }) {
  if (!hasCapability(actor, 'order', 'read', {
    ownerId: quotation.createdBy,
    department: quotation.creator.department,
  })) {
    fail('当前角色无权读取订单范围', 'AUTH_FORBIDDEN');
  }
}

function normalizedStatus(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function safeDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function assertFreshLife(detail: {
  shelfLifeDate: Date | null;
  shelfLifeDays: number | null;
  nextOverhaulDue: Date | null;
  lifeLimited: boolean;
  remainingHours: number | null;
  remainingCycles: number | null;
}) {
  const now = Date.now();
  const shelfLifeDate = safeDate(detail.shelfLifeDate);
  if (detail.shelfLifeDays !== null && !shelfLifeDate) fail('寿命库存缺少可核验的保质期日期');
  if (shelfLifeDate && shelfLifeDate.getTime() <= now) fail('库存明细已超过保质期');
  const overhaul = safeDate(detail.nextOverhaulDue);
  if (overhaul && overhaul.getTime() <= now) fail('库存明细已超过下次检修期限');
  if (detail.lifeLimited && detail.remainingHours === null && detail.remainingCycles === null) {
    fail('时寿库存缺少剩余寿命事实');
  }
  if (detail.lifeLimited
    && ((detail.remainingHours !== null && detail.remainingHours <= 0)
      || (detail.remainingCycles !== null && detail.remainingCycles <= 0))) {
    fail('时寿库存剩余寿命不足');
  }
}

function assertLineQuantities(line: {
  quantity: number;
  acceptedQuantity: number;
  reservedQuantity: number;
  currency: string;
}) {
  assertPositiveInteger(line.quantity, '报价行数量');
  if (!Number.isSafeInteger(line.acceptedQuantity) || line.acceptedQuantity < 0 || line.acceptedQuantity > line.quantity) {
    fail('报价行成交数量无效');
  }
  if (!Number.isSafeInteger(line.reservedQuantity) || line.reservedQuantity < 0 || line.reservedQuantity > line.quantity) {
    fail('报价行预留数量无效');
  }
  assertUsdQuotationCurrency(line.currency);
}

type LineContext = Awaited<ReturnType<typeof loadQuotationLine>>;

async function loadQuotationLine(tx: Tx, quotationLineId: string) {
  const line = await tx.quotationLine.findUnique({
    where: { id: quotationLineId },
    include: {
      rfqLine: true,
      quotation: {
        include: {
          creator: { select: { id: true, department: true } },
          rfq: { select: { id: true, urgency: true } },
          // Keep the approval snapshot shape identical to lineService's
          // canonical include: RFQ identity is loaded on the selected line,
          // while nested lines contain only their persisted line facts.
          lines: { orderBy: { lineNo: 'asc' } },
          approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!line) fail('报价行不存在', 'RESOURCE_NOT_FOUND');
  if (!line.rfqLine) fail('报价行需求来源不存在');
  return line;
}

async function loadQuotation(tx: Tx, quotationId: string) {
  const quotation = await tx.quotation.findUnique({
    where: { id: quotationId },
    include: {
      creator: { select: { id: true, department: true } },
      rfq: { select: { id: true, urgency: true } },
      lines: { orderBy: { lineNo: 'asc' } },
      approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!quotation) fail('报价单不存在', 'RESOURCE_NOT_FOUND');
  return quotation;
}

function assertCurrentLineApproval(quotation: LineContext['quotation']) {
  const decision = quotation.approvals[0];
  if (!decision || decision.action !== 'APPROVE'
    || decision.policyVersion !== `${QUOTATION_APPROVAL_POLICY_VERSION}-lines-v1`
    || !decision.snapshotJson) {
    fail('报价需要按当前审批策略重新审批后才能继续');
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(decision.snapshotJson);
  } catch {
    fail('报价审批快照不可解析');
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('报价审批快照无效');
  const current = buildCommercialApprovalSnapshot({
    headerTerms: buildQuotationApprovalSnapshot(quotation),
    lines: quotation.lines,
  });
  if (hashCommercialApprovalSnapshot(snapshot as Parameters<typeof hashCommercialApprovalSnapshot>[0])
    !== hashCommercialApprovalSnapshot(current)) {
    fail('报价行或商业条款已变化，需要重新审批');
  }
}

function assertQuoteCommercialReady(
  quotation: LineContext['quotation'],
  options: { allowSuperseded?: boolean; allowExpired?: boolean; requireApproval?: boolean } = {},
) {
  if (!quotation.lineItemsMode) fail('旧版整单报价不能进入现代库存分配');
  assertUsdQuotationCurrency(quotation.currency);
  assertSupportedSaleType(quotation.saleType);
  if (!options.allowSuperseded) assertActiveQuotationRevision(quotation);
  if (!options.allowExpired) assertQuotationValidity(quotation);
  if (!RESERVABLE_QUOTATION_STATUSES.has(normalizedStatus(quotation.status)) && !options.allowExpired) {
    fail('报价当前状态不能进行库存分配', 'INVALID_STATE_TRANSITION');
  }
  for (const line of quotation.lines) {
    assertLineQuantities(line);
    assertLineCostSnapshot(line);
  }
  if (options.requireApproval !== false) assertCurrentLineApproval(quotation);
}

function assertReserveStatus(quotation: LineContext['quotation']) {
  if (!RESERVABLE_QUOTATION_STATUSES.has(normalizedStatus(quotation.status))) {
    fail('只有已审批、已发送或已接受的报价可以预留库存', 'INVALID_STATE_TRANSITION');
  }
}

async function loadOrderLine(tx: Tx, orderLineId: string) {
  const orderLine = await tx.orderLine.findUnique({
    where: { id: orderLineId },
    include: {
      order: {
        select: {
          id: true,
          quotationId: true,
          lineItemsMode: true,
          status: true,
          customerId: true,
        },
      },
    },
  });
  if (!orderLine) fail('订单行不存在', 'RESOURCE_NOT_FOUND');
  return orderLine;
}

function assertOrderCanReceiveAllocation(orderLine: Awaited<ReturnType<typeof loadOrderLine>>) {
  if (!orderLine.order.lineItemsMode) fail('旧版整单订单不能进入现代库存分配');
  if (CLOSED_ORDER_STATUSES.has(normalizedStatus(orderLine.order.status))) {
    fail('订单已关闭，不能新增库存分配', 'INVALID_STATE_TRANSITION');
  }
  if (!ACTIVE_ORDER_STATUSES.has(normalizedStatus(orderLine.order.status))) {
    fail('当前订单状态不能接收库存分配', 'INVALID_STATE_TRANSITION');
  }
}

function assertOrderLineIdentity(
  orderLine: Awaited<ReturnType<typeof loadOrderLine>>,
  line: LineContext,
) {
  if (orderLine.quotationLineId !== line.id || orderLine.order.quotationId !== line.quotation.id) {
    fail('订单行与报价行不匹配');
  }
  if (orderLine.partNumber !== line.partNumber || !isLinePartAllowed(line.rfqLine, orderLine.partNumber)) {
    fail('订单行件号与报价行不一致');
  }
  if (!isLinePartAllowed(line.rfqLine, line.partNumber)) fail('报价行件号不属于当前需求行');
  const serial = line.serialNumber ?? line.rfqLine.serialNumber;
  const batch = line.batchNumber ?? line.rfqLine.batchNumber;
  if (serial && orderLine.serialNumber !== serial) fail('订单行序号与报价行不一致');
  if (batch && orderLine.batchNumber !== batch) fail('订单行批次与报价行不一致');
  if (orderLine.quantity <= 0 || orderLine.quantity > line.quantity) fail('订单行数量超过报价行数量');
}

async function loadDetail(tx: Tx, inventoryDetailId: string) {
  const detail = await tx.inventoryDetail.findUnique({
    where: { id: inventoryDetailId },
    include: { inventoryItem: true },
  });
  if (!detail) fail('库存明细不存在', 'RESOURCE_NOT_FOUND');
  return detail;
}

async function assertDetailProjection(tx: Tx, detail: { id: string; quantity: number; allocatedQuantity: number }) {
  const allocations = await tx.inventoryAllocation.findMany({
    where: { inventoryDetailId: detail.id },
    select: { allocatedQuantity: true, releasedQuantity: true, consumedQuantity: true },
  });
  const active = allocations.reduce((total, allocation) => {
    const quantity = allocation.allocatedQuantity - allocation.releasedQuantity - allocation.consumedQuantity;
    return total + quantity;
  }, 0);
  if (active < 0 || active !== detail.allocatedQuantity || detail.allocatedQuantity < 0 || detail.allocatedQuantity > detail.quantity) {
    fail('库存明细分配投影与父分配事实不一致', 'ALLOCATION_INCONSISTENT');
  }
  return active;
}

function assertDetailMatchesLine(
  detail: Awaited<ReturnType<typeof loadDetail>>,
  line: LineContext,
  requestedQuantity: number,
) {
  const partNumber = detail.inventoryItem.partNumber;
  if (partNumber !== line.partNumber || !isLinePartAllowed(line.rfqLine, line.partNumber)) fail('库存件号与报价行不一致');
  if (detail.conditionCode !== line.rfqLine.conditionCode) fail('库存条件与需求条件不一致');
  const requiredSerial = line.serialNumber ?? line.rfqLine.serialNumber;
  const requiredBatch = line.batchNumber ?? line.rfqLine.batchNumber;
  if (requiredSerial && detail.serialNumber !== requiredSerial) fail('库存序号与需求不一致');
  if (requiredBatch && detail.batchNumber !== requiredBatch) fail('库存批次与需求不一致');
  if (detail.status !== 'AVAILABLE') fail('预留或隔离库存不能进入现代分配');
  if (!SOURCE_TYPES.has(normalizedStatus(detail.type))) fail('首期现代分配仅支持自有库存');
  assertFreshLife(detail);
  const serialTracked = normalizedStatus(detail.inventoryItem.trackingType) === 'SERIAL' || Boolean(detail.serialNumber);
  if (serialTracked && !detail.serialNumber?.trim()) fail('序号跟踪库存必须有可核验的序号');
  if (serialTracked && !detail.serialNumber) fail('序号库存缺少序号事实');
  if (serialTracked && (detail.quantity !== 1 || requestedQuantity !== 1)) {
    fail('序号件必须按一件一分配');
  }
}

function assignmentActive(assignment: { assignedQuantity: number; releasedQuantity: number; consumedQuantity: number }) {
  return assignment.assignedQuantity - assignment.releasedQuantity - assignment.consumedQuantity;
}

function safeAllocation(allocation: {
  id: string;
  quotationLineId: string;
  inventoryDetailId: string;
  allocatedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
  expiresAt: Date | null;
  assignments: Array<{
    id: string;
    orderLineId: string;
    assignedQuantity: number;
    releasedQuantity: number;
    consumedQuantity: number;
  }>;
}): AllocationSafeView {
  const assignments = allocation.assignments.map(assignment => ({
    id: assignment.id,
    orderLineId: assignment.orderLineId,
    assignedQuantity: assignment.assignedQuantity,
    releasedQuantity: assignment.releasedQuantity,
    consumedQuantity: assignment.consumedQuantity,
    activeQuantity: assignmentActive(assignment),
  }));
  const summary = allocationQuantities({
    allocatedQuantity: allocation.allocatedQuantity,
    releasedQuantity: allocation.releasedQuantity,
    consumedQuantity: allocation.consumedQuantity,
    assignments,
  });
  return {
    id: allocation.id,
    quotationLineId: allocation.quotationLineId,
    inventoryDetailId: allocation.inventoryDetailId,
    allocatedQuantity: allocation.allocatedQuantity,
    releasedQuantity: allocation.releasedQuantity,
    consumedQuantity: allocation.consumedQuantity,
    activeQuantity: summary.activeQuantity,
    unassignedQuantity: summary.unassignedQuantity,
    assignedActiveQuantity: summary.assignedActiveQuantity,
    expiresAt: allocation.expiresAt,
    assignments,
  };
}

async function loadAllocationViews(tx: Tx, quotationLineId: string) {
  const allocations = await tx.inventoryAllocation.findMany({
    where: { quotationLineId },
    include: { assignments: { orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  return allocations.map(safeAllocation);
}

function summarizeViews(views: AllocationSafeView[]) {
  return views.reduce((result, view) => ({
    unassignedQuantity: result.unassignedQuantity + view.unassignedQuantity,
    assignedActiveQuantity: result.assignedActiveQuantity + view.assignedActiveQuantity,
    activeQuantity: result.activeQuantity + view.activeQuantity,
  }), { unassignedQuantity: 0, assignedActiveQuantity: 0, activeQuantity: 0 });
}

async function assertLineProjection(
  tx: Tx,
  quotation: LineContext['quotation'],
  line: LineContext,
  views?: AllocationSafeView[],
) {
  const currentViews = views ?? await loadAllocationViews(tx, line.id);
  const summary = summarizeViews(currentViews);
  if (line.reservedQuantity !== summary.unassignedQuantity) {
    fail('报价行预留投影与现代分配事实不一致', 'ALLOCATION_INCONSISTENT');
  }
  const allLines = quotation.lines.reduce((total, item) => total + item.reservedQuantity, 0);
  if (quotation.reservedQuantity !== allLines) {
    fail('报价预留总量与报价行投影不一致', 'ALLOCATION_INCONSISTENT');
  }
  return { views: currentViews, ...summary };
}

async function updateUnassignedProjection(
  tx: Tx,
  quotation: LineContext['quotation'],
  line: LineContext,
  delta: number,
) {
  if (delta === 0) return;
  const nextLineReserved = line.reservedQuantity + delta;
  const nextQuoteReserved = quotation.reservedQuantity + delta;
  if (nextLineReserved < 0 || nextLineReserved > line.quantity || nextQuoteReserved < 0) {
    fail('报价预留投影数量无效');
  }
  const updatedLine = await tx.quotationLine.updateMany({
    where: { id: line.id, reservedQuantity: line.reservedQuantity },
    data: { reservedQuantity: nextLineReserved },
  });
  if (updatedLine.count !== 1) fail('报价行被并发修改，请重试', 'STATE_CONFLICT');
  const updatedQuotation = await tx.quotation.updateMany({
    where: {
      id: quotation.id,
      version: quotation.version,
      reservedQuantity: quotation.reservedQuantity,
    },
    data: { reservedQuantity: nextQuoteReserved, version: { increment: 1 } },
  });
  if (updatedQuotation.count !== 1) fail('报价被并发修改，请重试', 'STATE_CONFLICT');
}

function allocationEventFacts(value: {
  allocatedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
  assignments?: Array<{ assignedQuantity: number; releasedQuantity: number; consumedQuantity: number }>;
}) {
  const assignments = value.assignments ?? [];
  const assignedQuantity = assignments.reduce((sum, item) => sum + item.assignedQuantity, 0);
  const releasedAssignmentQuantity = assignments.reduce((sum, item) => sum + item.releasedQuantity, 0);
  const assignedActiveQuantity = assignments.reduce(
    (sum, item) => sum + assignmentActive(item),
    0,
  );
  const activeQuantity = value.allocatedQuantity - value.releasedQuantity - value.consumedQuantity;
  const unassignedQuantity = value.allocatedQuantity - assignedQuantity - value.releasedQuantity + releasedAssignmentQuantity;
  return {
    allocatedQuantity: value.allocatedQuantity,
    releasedQuantity: value.releasedQuantity,
    consumedQuantity: value.consumedQuantity,
    activeQuantity,
    unassignedQuantity,
    assignedActiveQuantity,
  };
}

function assignmentEventFacts(value: { assignedQuantity: number; releasedQuantity: number; consumedQuantity: number }) {
  return {
    assignedQuantity: value.assignedQuantity,
    releasedQuantity: value.releasedQuantity,
    consumedQuantity: value.consumedQuantity,
    activeQuantity: assignmentActive(value),
  };
}

async function createEvent(
  tx: Tx,
  args: {
    allocationId: string;
    assignmentId?: string | null;
    kind: string;
    quantity: number;
    before: Prisma.InputJsonValue;
    after: Prisma.InputJsonValue;
    commandId: string;
    eventNo: number;
    actorId?: string | null;
  },
) {
  await tx.inventoryAllocationEvent.create({
    data: {
      allocationId: args.allocationId,
      assignmentId: args.assignmentId ?? null,
      kind: args.kind,
      quantity: args.quantity,
      before: args.before,
      after: args.after,
      commandId: args.commandId,
      eventNo: args.eventNo,
      actorId: args.actorId ?? null,
    },
  });
}

/**
 * Allocation writes also publish a transactional refresh.  The outbox body is
 * deliberately an operational identity only; clients must refetch the scoped
 * allocation view and never receive quote, order, customer or cost facts from
 * this event.
 */
async function enqueueAllocationRefresh(
  tx: Tx,
  args: {
    allocationId: string;
    quotationLineId?: string;
    inventoryDetailId?: string;
    assignmentId?: string | null;
    kind: string;
    allocationVersion: number;
    assignmentVersion?: number;
    actorId?: string | null;
  },
) {
  await enqueueBusinessEvent(tx, {
    eventType: `inventory.allocation.${args.kind.toLowerCase()}`,
    aggregateType: 'INVENTORY_ALLOCATION',
    aggregateId: args.allocationId,
    data: {
      allocationId: args.allocationId,
      ...(args.quotationLineId ? { quotationLineId: args.quotationLineId } : {}),
      ...(args.inventoryDetailId ? { inventoryDetailId: args.inventoryDetailId } : {}),
      ...(args.assignmentId ? { assignmentId: args.assignmentId } : {}),
      kind: args.kind,
      allocationVersion: args.allocationVersion,
      ...(args.assignmentVersion === undefined ? {} : { assignmentVersion: args.assignmentVersion }),
      refresh: true,
    },
    socket: {
      room: SocketRooms.INVENTORY,
      event: SocketEvents.INVENTORY_UPDATED,
      scope: { capability: 'inventory.read' },
    },
    createdById: args.actorId ?? null,
  });
}

function commandMismatch(message = '幂等命令与历史库存分配事实不一致'): never {
  fail(message, 'IDEMPOTENCY_KEY_REUSED');
}

async function replayReserve(
  tx: Tx,
  args: { commandId: string; quotationLineId: string; orderLineId?: string; allocations: AllocationInput[]; actor: AllocationActor },
) {
  const parents = await tx.inventoryAllocation.findMany({
    where: { commandId: args.commandId },
    include: { assignments: { orderBy: { id: 'asc' } } },
    orderBy: { commandLineNo: 'asc' },
  });
  if (parents.length === 0) return null;
  const requested = normalizeAllocations(args.allocations);
  if (parents.length !== requested.length) commandMismatch();
  for (const [index, item] of requested.entries()) {
    const parent = parents[index];
    if (!parent || parent.commandLineNo !== index + 1 || parent.quotationLineId !== args.quotationLineId
      || parent.inventoryDetailId !== item.inventoryDetailId || parent.allocatedQuantity !== item.quantity) commandMismatch();
    // A later assign command is a new fact and must not change the replay
    // shape of the original reserve command.  Only an assignment carrying
    // this same command ID belongs to the reserve operation itself.
    const commandAssignments = parent.assignments.filter(assignment => assignment.commandId === args.commandId);
    if (args.orderLineId) {
      if (commandAssignments.length !== 1) commandMismatch();
      const assignment = commandAssignments[0];
      if (assignment.orderLineId !== args.orderLineId || assignment.assignedQuantity !== item.quantity) commandMismatch();
    } else if (commandAssignments.length !== 0) {
      commandMismatch();
    }
  }
  const line = await loadQuotationLine(tx, args.quotationLineId);
  assertQuoteRead(args.actor, line.quotation);
  if (args.orderLineId) assertOrderRead(args.actor, line.quotation);
  return {
    commandId: args.commandId,
    replayed: true,
    quotationLineId: args.quotationLineId,
    orderLineId: args.orderLineId ?? null,
    allocations: await loadAllocationViews(tx, args.quotationLineId),
  };
}

export async function reserveLineInventory(args: {
  tx: Tx;
  actor: AllocationActor;
  quotationLineId: string;
  orderLineId?: string;
  allocations: AllocationInput[];
  commandId: string;
}) {
  assertInventoryManager(args.actor);
  const quotationLineId = assertId(args.quotationLineId, 'quotationLineId');
  const commandId = assertId(args.commandId, 'commandId');
  const orderLineId = args.orderLineId ? assertId(args.orderLineId, 'orderLineId') : undefined;
  const replay = await replayReserve(args.tx, { ...args, quotationLineId, orderLineId, commandId });
  if (replay) return replay;

  const requested = normalizeAllocations(args.allocations);
  if (orderLineId) await lockPurchaseCoverageLines(args.tx, [orderLineId]);
  const line = await loadQuotationLine(args.tx, quotationLineId);
  assertQuoteRead(args.actor, line.quotation);
  const orderLine = orderLineId ? await loadOrderLine(args.tx, orderLineId) : null;
  if (orderLine) {
    // An already-created order may finish its stock binding after the
    // commercial offer expired, was withdrawn, or was superseded.  It still
    // must pass the immutable approval snapshot, USD/Sale, and line identity
    // checks below; only the active-offer gate is relaxed for this path.
    assertOrderRead(args.actor, line.quotation);
    assertQuoteCommercialReady(line.quotation, { allowSuperseded: true, allowExpired: true });
  } else {
    assertQuoteCommercialReady(line.quotation);
    assertReserveStatus(line.quotation);
  }
  const projection = await assertLineProjection(args.tx, line.quotation, line);
  if (orderLine) {
    assertOrderCanReceiveAllocation(orderLine);
    assertOrderLineIdentity(orderLine, line);
    if (orderLine.order.customerId !== line.quotation.customerId) fail('订单客户与报价客户不一致');
    if (line.acceptedQuantity < orderLine.quantity) fail('订单成交数量尚未在报价行中确认');
  }

  const requestedTotal = requested.reduce((total, item) => total + item.quantity, 0);
  const commercialOpen = line.quantity - line.acceptedQuantity;
  if (!orderLine && requestedTotal > commercialOpen - projection.unassignedQuantity) {
    fail('报价行未成交余量不足，不能新增未分配库存预留');
  }
  if (orderLine) {
    const existingOrderAssignments = await args.tx.allocationAssignment.findMany({
      where: { orderLineId: orderLine.id },
      select: { assignedQuantity: true, releasedQuantity: true, consumedQuantity: true },
    });
    const assigned = existingOrderAssignments.reduce((sum, item) => sum + assignmentActive(item), 0);
    await assertAdditionalStockCoverage(args.tx, { orderLineId: orderLine.id, orderQuantity: orderLine.quantity,
      assignments: existingOrderAssignments, additionalQuantity: requestedTotal });
    if (requestedTotal > orderLine.quantity - orderLine.outboundQuantity - assigned) {
      fail('订单行待履约数量不足，不能新增库存分配');
    }
  }

  const details = await Promise.all(requested.map(item => loadDetail(args.tx, item.inventoryDetailId)));
  for (const [index, detail] of details.entries()) {
    assertDetailMatchesLine(detail, line, requested[index].quantity);
    await assertInventoryUseAllowed(args.tx, detail);
    const active = await assertDetailProjection(args.tx, detail);
    if (detail.quantity - active < requested[index].quantity) fail('库存数量不足');
  }

  const created: string[] = [];
  let eventNo = 1;
  for (const [index, item] of requested.entries()) {
    const detail = details[index];
    const beforeDetailAllocated = detail.allocatedQuantity;
    const detailUpdate = await args.tx.inventoryDetail.updateMany({
      where: {
        id: detail.id,
        status: 'AVAILABLE',
        quantity: detail.quantity,
        allocatedQuantity: beforeDetailAllocated,
      },
      data: { allocatedQuantity: { increment: item.quantity } },
    });
    if (detailUpdate.count !== 1) fail('库存明细被并发修改，请重试', 'STATE_CONFLICT');
    const parent = await args.tx.inventoryAllocation.create({
      data: {
        quotationLineId: line.id,
        inventoryDetailId: detail.id,
        allocatedQuantity: item.quantity,
        expiresAt: line.quotation.expiryDate,
        commandId,
        commandLineNo: index + 1,
        createdById: args.actor.id,
      },
    });
    created.push(parent.id);
    await createEvent(args.tx, {
      allocationId: parent.id,
      kind: 'RESERVE',
      quantity: item.quantity,
      before: allocationEventFacts({ allocatedQuantity: 0, releasedQuantity: 0, consumedQuantity: 0 }),
      after: allocationEventFacts({ allocatedQuantity: item.quantity, releasedQuantity: 0, consumedQuantity: 0 }),
      commandId,
      eventNo: eventNo++,
      actorId: args.actor.id,
    });
    let assignmentVersion: number | undefined;
    let assignmentId: string | null = null;
    if (orderLine) {
      const assignment = await args.tx.allocationAssignment.create({
        data: {
          allocationId: parent.id,
          orderLineId: orderLine.id,
          assignedQuantity: item.quantity,
          commandId,
          commandLineNo: index + 1,
          createdById: args.actor.id,
        },
      });
      await createEvent(args.tx, {
        allocationId: parent.id,
        assignmentId: assignment.id,
        kind: 'ASSIGN',
        quantity: item.quantity,
        before: assignmentEventFacts({ assignedQuantity: 0, releasedQuantity: 0, consumedQuantity: 0 }),
        after: assignmentEventFacts(assignment),
        commandId,
        eventNo: eventNo++,
        actorId: args.actor.id,
      });
      assignmentVersion = assignment.version;
      assignmentId = assignment.id;
    }
    await enqueueAllocationRefresh(args.tx, {
      allocationId: parent.id,
      quotationLineId: line.id,
      inventoryDetailId: detail.id,
      assignmentId,
      kind: orderLine ? 'ASSIGN' : 'RESERVE',
      allocationVersion: parent.version,
      assignmentVersion,
      actorId: args.actor.id,
    });
  }

  if (!orderLine) await updateUnassignedProjection(args.tx, line.quotation, line, requestedTotal);
  const allocations = await loadAllocationViews(args.tx, line.id);
  return {
    commandId,
    replayed: false,
    quotationLineId: line.id,
    orderLineId: orderLine?.id ?? null,
    createdAllocationIds: created,
    allocations,
  };
}

async function replayAssign(
  tx: Tx,
  args: { commandId: string; orderLineId: string; allocations: AssignmentInput[]; actor: AllocationActor },
) {
  const assignments = await tx.allocationAssignment.findMany({
    where: { commandId: args.commandId },
    orderBy: { commandLineNo: 'asc' },
  });
  if (assignments.length === 0) return null;
  const requested = normalizeAssignmentInputs(args.allocations);
  if (assignments.length !== requested.length) commandMismatch();
  let quotationLineId: string | null = null;
  for (const [index, item] of requested.entries()) {
    const assignment = assignments[index];
    if (!assignment || assignment.commandLineNo !== index + 1 || assignment.orderLineId !== args.orderLineId
      || assignment.assignedQuantity !== item.quantity) commandMismatch();
    const parent = await tx.inventoryAllocation.findUnique({ where: { id: assignment.allocationId }, select: { quotationLineId: true } });
    if (!parent) commandMismatch('幂等命令关联的父分配不存在');
    if (!quotationLineId) quotationLineId = parent.quotationLineId;
    if (quotationLineId !== parent.quotationLineId) commandMismatch('一次命令不能跨报价行进行分配');
  }
  if (!quotationLineId) commandMismatch();
  const line = await loadQuotationLine(tx, quotationLineId);
  assertQuoteRead(args.actor, line.quotation);
  assertOrderRead(args.actor, line.quotation);
  return {
    commandId: args.commandId,
    replayed: true,
    quotationLineId,
    orderLineId: args.orderLineId,
    allocations: await loadAllocationViews(tx, quotationLineId),
  };
}

export async function assignLineInventory(args: {
  tx: Tx;
  actor: AllocationActor;
  orderLineId: string;
  allocations: AssignmentInput[];
  commandId: string;
}) {
  assertInventoryManager(args.actor);
  const orderLineId = assertId(args.orderLineId, 'orderLineId');
  const commandId = assertId(args.commandId, 'commandId');
  const replay = await replayAssign(args.tx, { ...args, orderLineId, commandId });
  if (replay) return replay;
  const requested = normalizeAssignmentInputs(args.allocations);
  await lockPurchaseCoverageLines(args.tx, [orderLineId]);
  const orderLine = await loadOrderLine(args.tx, orderLineId);
  const parentRows = await args.tx.inventoryAllocation.findMany({
    where: { id: { in: requested.map(item => item.allocationId) } },
    include: { assignments: { orderBy: { id: 'asc' } }, inventoryDetail: { include: { inventoryItem: true } } },
    orderBy: { id: 'asc' },
  });
  if (parentRows.length !== requested.length) fail('库存分配不存在', 'RESOURCE_NOT_FOUND');
  const parentById = new Map(parentRows.map(parent => [parent.id, parent]));
  const lineIds = new Set(parentRows.map(parent => parent.quotationLineId));
  if (lineIds.size !== 1) fail('一次命令不能跨报价行进行分配');
  const quotationLineId = parentRows[0].quotationLineId;
  const line = await loadQuotationLine(args.tx, quotationLineId);
  assertQuoteRead(args.actor, line.quotation);
  assertOrderRead(args.actor, line.quotation);
  // A superseded quote may finish an already-open order transition, but an
  // expired offer cannot create a new order binding from an unassigned pool.
  assertQuoteCommercialReady(line.quotation, { allowSuperseded: true });
  assertReserveStatus(line.quotation);
  assertOrderCanReceiveAllocation(orderLine);
  assertOrderLineIdentity(orderLine, line);
  await assertLineProjection(args.tx, line.quotation, line);
  if (line.quotation.id !== orderLine.order.quotationId) fail('订单与报价不匹配');
  const existingOrderAssignments = await args.tx.allocationAssignment.findMany({
    where: { orderLineId },
    select: { assignedQuantity: true, releasedQuantity: true, consumedQuantity: true },
  });
  let activeOrderAssigned = existingOrderAssignments.reduce((sum, item) => sum + assignmentActive(item), 0);
  const requestedTotal = requested.reduce((sum, item) => sum + item.quantity, 0);
  await assertAdditionalStockCoverage(args.tx, { orderLineId, orderQuantity: orderLine.quantity,
    assignments: existingOrderAssignments, additionalQuantity: requestedTotal });
  if (requestedTotal > orderLine.quantity - orderLine.outboundQuantity - activeOrderAssigned) {
    fail('订单行待履约数量不足，不能新增库存分配');
  }
  for (const item of requested) {
    const parent = parentById.get(item.allocationId);
    if (!parent) fail('库存分配不存在', 'RESOURCE_NOT_FOUND');
    if (parent.quotationLineId !== line.id) fail('库存分配与报价行不匹配');
    const summary = allocationQuantities({
      allocatedQuantity: parent.allocatedQuantity,
      releasedQuantity: parent.releasedQuantity,
      consumedQuantity: parent.consumedQuantity,
      assignments: parent.assignments,
    });
    if (item.quantity > summary.unassignedQuantity) fail('未分配预留数量不足');
    if (parent.inventoryDetail.status !== 'AVAILABLE') fail('库存明细当前不可继续分配');
    assertDetailMatchesLine(parent.inventoryDetail, line, item.quantity);
    activeOrderAssigned += item.quantity;
  }

  const created: string[] = [];
  for (const [index, item] of requested.entries()) {
    const parent = parentById.get(item.allocationId)!;
    // A child assignment changes the parent's conservation facts even though
    // its counters stay the same. Versioning the parent makes the assignment
    // an explicit CAS boundary and invalidates a concurrent stale writer.
    const parentVersion = await args.tx.inventoryAllocation.updateMany({
      where: {
        id: parent.id,
        version: parent.version,
        releasedQuantity: parent.releasedQuantity,
        consumedQuantity: parent.consumedQuantity,
      },
      data: { version: { increment: 1 } },
    });
    if (parentVersion.count !== 1) fail('库存分配被并发修改，请重试', 'STATE_CONFLICT');
    const assignment = await args.tx.allocationAssignment.create({
      data: {
        allocationId: parent.id,
        orderLineId,
        assignedQuantity: item.quantity,
        commandId,
        commandLineNo: index + 1,
        createdById: args.actor.id,
      },
    });
    created.push(assignment.id);
    await createEvent(args.tx, {
      allocationId: parent.id,
      assignmentId: assignment.id,
      kind: 'ASSIGN',
      quantity: item.quantity,
      before: allocationEventFacts(parent),
      after: allocationEventFacts({ ...parent, assignments: [...parent.assignments, assignment] }),
      commandId,
      eventNo: index + 1,
      actorId: args.actor.id,
    });
    await enqueueAllocationRefresh(args.tx, {
      allocationId: parent.id,
      quotationLineId: line.id,
      inventoryDetailId: parent.inventoryDetailId,
      assignmentId: assignment.id,
      kind: 'ASSIGN',
      allocationVersion: parent.version + 1,
      assignmentVersion: assignment.version,
      actorId: args.actor.id,
    });
  }
  await updateUnassignedProjection(args.tx, line.quotation, line, -requestedTotal);
  return {
    commandId,
    replayed: false,
    quotationLineId: line.id,
    orderLineId,
    createdAssignmentIds: created,
    allocations: await loadAllocationViews(args.tx, line.id),
  };
}

async function replayRelease(
  tx: Tx,
  args: { commandId: string; allocationId: string; assignmentId?: string; quantity: number; reason: string; actor: AllocationActor },
) {
  const events = await tx.inventoryAllocationEvent.findMany({
    where: { commandId: args.commandId },
    orderBy: { eventNo: 'asc' },
  });
  if (events.length === 0) return null;
  if (!events.every(event => event.kind === 'RELEASE' && event.allocationId === args.allocationId
    && (event.assignmentId ?? undefined) === args.assignmentId && event.quantity === args.quantity)) {
    commandMismatch();
  }
  // The first event is the parent release event and carries the normalized
  // reason in its `after` facts.  Child assignment events intentionally carry
  // only assignment counters, so checking every event would reject valid
  // assigned releases.  Older events without this durable reason cannot be
  // safely replayed after the idempotency cache expires.
  const parentEvent = events.find(event => event.eventNo === 1);
  const parentAfter = parentEvent?.after;
  if (!parentEvent || !parentAfter || typeof parentAfter !== 'object' || Array.isArray(parentAfter)
    || (parentAfter as Record<string, unknown>).reason !== args.reason.trim()) {
    commandMismatch('幂等释放命令缺少或不匹配历史释放原因');
  }
  const allocation = await tx.inventoryAllocation.findUnique({ where: { id: args.allocationId }, select: { quotationLineId: true } });
  if (!allocation) commandMismatch('幂等命令关联的父分配不存在');
  const line = await loadQuotationLine(tx, allocation.quotationLineId);
  assertQuoteRead(args.actor, line.quotation);
  return {
    commandId: args.commandId,
    replayed: true,
    quotationLineId: line.id,
    allocationId: args.allocationId,
    assignmentId: args.assignmentId ?? null,
    reason: args.reason.trim(),
    allocations: await loadAllocationViews(tx, line.id),
  };
}

export async function releaseLineInventory(args: {
  tx: Tx;
  actor: AllocationActor;
  allocationId: string;
  assignmentId?: string;
  quantity: number;
  reason: string;
  commandId: string;
}) {
  assertInventoryManager(args.actor);
  const allocationId = assertId(args.allocationId, 'allocationId');
  const commandId = assertId(args.commandId, 'commandId');
  assertPositiveInteger(args.quantity, 'quantity');
  if (typeof args.reason !== 'string' || !args.reason.trim()) fail('释放原因不能为空', 'VALIDATION_ERROR');
  const replay = await replayRelease(args.tx, { ...args, allocationId, commandId, reason: args.reason.trim() });
  if (replay) return replay;
  const allocation = await args.tx.inventoryAllocation.findUnique({
    where: { id: allocationId },
    include: {
      assignments: { orderBy: { id: 'asc' } },
      inventoryDetail: { include: { inventoryItem: true } },
    },
  });
  if (!allocation) fail('库存分配不存在', 'RESOURCE_NOT_FOUND');
  const line = await loadQuotationLine(args.tx, allocation.quotationLineId);
  assertQuoteRead(args.actor, line.quotation);
  assertQuoteCommercialReady(line.quotation, { allowSuperseded: true, allowExpired: true, requireApproval: false });
  const views = await assertLineProjection(args.tx, line.quotation, line);
  const detailActive = await assertDetailProjection(args.tx, allocation.inventoryDetail);
  void detailActive;
  const selectedAssignment = args.assignmentId
    ? allocation.assignments.find(assignment => assignment.id === args.assignmentId)
    : null;
  if (args.assignmentId && !selectedAssignment) fail('订单分配不存在', 'RESOURCE_NOT_FOUND');
  if (selectedAssignment) {
    const orderLine = await loadOrderLine(args.tx, selectedAssignment.orderLineId);
    assertOrderRead(args.actor, line.quotation);
    assertOrderLineIdentity(orderLine, line);
    if (args.quantity > assignmentActive(selectedAssignment)) fail('订单分配可释放数量不足');
  } else {
    const allocationView = views.views.find(item => item.id === allocation.id);
    if (!allocationView) fail('父分配投影不存在', 'ALLOCATION_INCONSISTENT');
    if (args.quantity > allocationView.unassignedQuantity) {
      fail('父分配未绑定订单的可释放数量不足');
    }
  }
  const beforeParent = allocationEventFacts(allocation);
  const beforeAssignment = selectedAssignment ? assignmentEventFacts(selectedAssignment) : null;
  const parentUpdate = await args.tx.inventoryAllocation.updateMany({
    where: {
      id: allocation.id,
      version: allocation.version,
      releasedQuantity: allocation.releasedQuantity,
      consumedQuantity: allocation.consumedQuantity,
    },
    data: { releasedQuantity: { increment: args.quantity }, version: { increment: 1 } },
  });
  if (parentUpdate.count !== 1) fail('库存分配被并发修改，请重试', 'STATE_CONFLICT');
  if (selectedAssignment) {
    const childUpdate = await args.tx.allocationAssignment.updateMany({
      where: {
        id: selectedAssignment.id,
        version: selectedAssignment.version,
        releasedQuantity: selectedAssignment.releasedQuantity,
        consumedQuantity: selectedAssignment.consumedQuantity,
      },
      data: { releasedQuantity: { increment: args.quantity }, version: { increment: 1 } },
    });
    if (childUpdate.count !== 1) fail('订单库存分配被并发修改，请重试', 'STATE_CONFLICT');
  }
  const detailUpdate = await args.tx.inventoryDetail.updateMany({
    where: {
      id: allocation.inventoryDetailId,
      quantity: allocation.inventoryDetail.quantity,
      allocatedQuantity: allocation.inventoryDetail.allocatedQuantity,
    },
    data: { allocatedQuantity: { decrement: args.quantity } },
  });
  if (detailUpdate.count !== 1) fail('库存明细被并发修改，请重试', 'STATE_CONFLICT');
  await createEvent(args.tx, {
    allocationId: allocation.id,
    assignmentId: selectedAssignment?.id ?? null,
    kind: 'RELEASE',
    quantity: args.quantity,
    before: beforeParent,
    after: {
      ...allocationEventFacts({
        ...allocation,
        releasedQuantity: allocation.releasedQuantity + args.quantity,
        assignments: selectedAssignment
          ? allocation.assignments.map(item => item.id === selectedAssignment.id
            ? { ...item, releasedQuantity: item.releasedQuantity + args.quantity } : item)
          : allocation.assignments,
      }),
      reason: args.reason.trim(),
    } as Prisma.InputJsonObject,
    commandId,
    eventNo: 1,
    actorId: args.actor.id,
  });
  if (selectedAssignment && beforeAssignment) {
    await createEvent(args.tx, {
      allocationId: allocation.id,
      assignmentId: selectedAssignment.id,
      kind: 'RELEASE',
      quantity: args.quantity,
      before: beforeAssignment,
      after: assignmentEventFacts({ ...selectedAssignment, releasedQuantity: selectedAssignment.releasedQuantity + args.quantity }),
      commandId,
      eventNo: 2,
      actorId: args.actor.id,
    });
  }
  await enqueueAllocationRefresh(args.tx, {
    allocationId: allocation.id,
    quotationLineId: line.id,
    inventoryDetailId: allocation.inventoryDetailId,
    assignmentId: selectedAssignment?.id ?? null,
    kind: 'RELEASE',
    allocationVersion: allocation.version + 1,
    assignmentVersion: selectedAssignment ? selectedAssignment.version + 1 : undefined,
    actorId: args.actor.id,
  });
  if (!selectedAssignment) await updateUnassignedProjection(args.tx, line.quotation, line, -args.quantity);
  return {
    commandId,
    replayed: false,
    quotationLineId: line.id,
    allocationId: allocation.id,
    assignmentId: selectedAssignment?.id ?? null,
    reason: args.reason.trim(),
    allocations: await loadAllocationViews(args.tx, line.id),
  };
}

export async function releaseUnassignedQuotationInventory(args: {
  tx: Tx;
  quotationId: string;
  actorId: string | null;
  reason: string;
  commandId: string;
  actor?: AllocationActor;
}) {
  const quotationId = assertId(args.quotationId, 'quotationId');
  const commandId = assertId(args.commandId, 'commandId');
  if (typeof args.reason !== 'string' || !args.reason.trim()) fail('释放原因不能为空', 'VALIDATION_ERROR');
  const quotation = await loadQuotation(args.tx, quotationId);
  if (args.actor) {
    assertInventoryManager(args.actor);
    assertQuoteRead(args.actor, quotation);
  }
  if (!quotation.lineItemsMode) fail('旧版整单报价不能进入现代库存分配');
  assertUsdQuotationCurrency(quotation.currency);
  assertSupportedSaleType(quotation.saleType);
  const replayEvents = await args.tx.inventoryAllocationEvent.findMany({
    where: { commandId },
    orderBy: { eventNo: 'asc' },
    select: { allocationId: true, assignmentId: true, kind: true, quantity: true, after: true },
  });
  if (replayEvents.length > 0) {
    if (replayEvents.some(event => event.kind !== 'RELEASE' || event.assignmentId !== null
      || !event.after || typeof event.after !== 'object' || Array.isArray(event.after)
      || (event.after as Record<string, unknown>).reason !== args.reason.trim())) {
      commandMismatch();
    }
    const lineViews = await Promise.all(quotation.lines.map(line => loadAllocationViews(args.tx, line.id)));
    const allocationIds = new Set(quotation.lines.flatMap((_, index) => lineViews[index].map(view => view.id)));
    if (replayEvents.some(event => !allocationIds.has(event.allocationId))) commandMismatch();
    return {
      commandId,
      replayed: true,
      quotationId,
      actorId: args.actorId,
      reason: args.reason.trim(),
      releasedQuantity: replayEvents.reduce((sum, event) => sum + event.quantity, 0),
      preservedAssignedQuantity: lineViews.flatMap(views => views).reduce((sum, view) => sum + view.assignedActiveQuantity, 0),
      lines: quotation.lines.map((line, index) => ({ quotationLineId: line.id, allocations: lineViews[index] })),
    };
  }
  const allViews = await Promise.all(quotation.lines.map(line => loadAllocationViews(args.tx, line.id)));
  const lineSummaries = quotation.lines.map((line, index) => ({
    line,
    views: allViews[index],
    summary: summarizeViews(allViews[index]),
  }));
  for (const item of lineSummaries) {
    if (item.line.reservedQuantity !== item.summary.unassignedQuantity) {
      fail('报价行预留投影与现代分配事实不一致', 'ALLOCATION_INCONSISTENT');
    }
  }
  if (quotation.reservedQuantity !== quotation.lines.reduce((sum, line) => sum + line.reservedQuantity, 0)) {
    fail('报价预留总量与报价行投影不一致', 'ALLOCATION_INCONSISTENT');
  }
  const targets = lineSummaries.flatMap(item => item.views
    .filter(view => view.unassignedQuantity > 0)
    .map(view => ({ line: item.line, view })));
  let totalReleased = 0;
  let eventNo = 1;
  for (const target of targets.sort((left, right) => left.view.id.localeCompare(right.view.id))) {
    const allocation = await args.tx.inventoryAllocation.findUnique({
      where: { id: target.view.id },
      include: { assignments: { orderBy: { id: 'asc' } }, inventoryDetail: true },
    });
    if (!allocation) fail('库存分配不存在', 'RESOURCE_NOT_FOUND');
    await assertDetailProjection(args.tx, allocation.inventoryDetail);
    const before = allocationEventFacts(allocation);
    const releaseQuantity = target.view.unassignedQuantity;
    const parentUpdate = await args.tx.inventoryAllocation.updateMany({
      where: {
        id: allocation.id,
        version: allocation.version,
        releasedQuantity: allocation.releasedQuantity,
        consumedQuantity: allocation.consumedQuantity,
      },
      data: { releasedQuantity: { increment: releaseQuantity }, version: { increment: 1 } },
    });
    if (parentUpdate.count !== 1) fail('库存分配被并发修改，请重试', 'STATE_CONFLICT');
    const detailUpdate = await args.tx.inventoryDetail.updateMany({
      where: {
        id: allocation.inventoryDetailId,
        quantity: allocation.inventoryDetail.quantity,
        allocatedQuantity: allocation.inventoryDetail.allocatedQuantity,
      },
      data: { allocatedQuantity: { decrement: releaseQuantity } },
    });
    if (detailUpdate.count !== 1) fail('库存明细被并发修改，请重试', 'STATE_CONFLICT');
    await createEvent(args.tx, {
      allocationId: allocation.id,
      kind: 'RELEASE',
      quantity: releaseQuantity,
      before,
      after: {
        ...allocationEventFacts({ ...allocation, releasedQuantity: allocation.releasedQuantity + releaseQuantity }),
        reason: args.reason.trim(),
      },
      commandId,
      eventNo: eventNo++,
      actorId: args.actorId,
    });
    await enqueueAllocationRefresh(args.tx, {
      allocationId: allocation.id,
      quotationLineId: target.line.id,
      inventoryDetailId: allocation.inventoryDetailId,
      kind: 'RELEASE',
      allocationVersion: allocation.version + 1,
      actorId: args.actorId,
    });
    totalReleased += releaseQuantity;
  }
  for (const item of lineSummaries) {
    if (item.summary.unassignedQuantity > 0) {
      const updated = await args.tx.quotationLine.updateMany({
        where: { id: item.line.id, reservedQuantity: item.line.reservedQuantity },
        data: { reservedQuantity: { decrement: item.summary.unassignedQuantity } },
      });
      if (updated.count !== 1) fail('报价行被并发修改，请重试', 'STATE_CONFLICT');
    }
  }
  if (totalReleased > 0) {
    const updated = await args.tx.quotation.updateMany({
      where: { id: quotation.id, version: quotation.version, reservedQuantity: quotation.reservedQuantity },
      data: { reservedQuantity: { decrement: totalReleased }, version: { increment: 1 } },
    });
    if (updated.count !== 1) fail('报价被并发修改，请重试', 'STATE_CONFLICT');
  }
  const lines = await Promise.all(quotation.lines.map(line => loadAllocationViews(args.tx, line.id)));
  return {
    commandId,
    quotationId,
    actorId: args.actorId,
    reason: args.reason.trim(),
    releasedQuantity: totalReleased,
    preservedAssignedQuantity: lineSummaries.reduce((sum, item) => sum + item.summary.assignedActiveQuantity, 0),
    lines: quotation.lines.map((line, index) => ({ quotationLineId: line.id, allocations: lines[index] })),
  };
}

export async function getLineInventoryAvailability(args: {
  tx: Tx;
  actor: AllocationActor;
  quotationLineId: string;
}): Promise<LineInventoryAvailability> {
  const quotationLineId = assertId(args.quotationLineId, 'quotationLineId');
  const line = await loadQuotationLine(args.tx, quotationLineId);
  assertQuoteRead(args.actor, line.quotation);
  if (!line.quotation.lineItemsMode) fail('旧版整单报价没有现代行级分配视图');
  const allocations = await loadAllocationViews(args.tx, line.id);
  const summary = summarizeViews(allocations);
  if (line.reservedQuantity !== summary.unassignedQuantity) {
    fail('报价行预留投影与现代分配事实不一致', 'ALLOCATION_INCONSISTENT');
  }
  return {
    quotationLineId: line.id,
    quantity: line.quantity,
    acceptedQuantity: line.acceptedQuantity,
    reservedQuantity: line.reservedQuantity,
    unassignedQuantity: summary.unassignedQuantity,
    assignedActiveQuantity: summary.assignedActiveQuantity,
    activeQuantity: summary.activeQuantity,
    allocations,
  };
}
