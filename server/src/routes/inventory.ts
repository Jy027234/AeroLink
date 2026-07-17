import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { requireCapability } from '../middleware/capability.js';
import { createAuditLog } from '../middleware/auditLogger.js';
import { inventoryUpdateSchema, inventoryCreateSchema } from '../lib/validation.js';
import { SocketEvents, SocketRooms } from '../lib/socketEvents.js';
import { loadInventoryReconciliation } from '../lib/inventoryReconciliation.js';
import { serializeInventoryDetail } from '../lib/inventoryProjection.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { enqueueBusinessEvent } from '../lib/outboxService.js';
import { parseControlledExportWindow, parseListQuery, sendCsv, type SortDirection } from '../lib/listQuery.js';
import prisma from '../lib/prisma.js';

const router = Router();
const requireInventoryMutationRole = requireCapability('inventory', 'manage');
const requireInventoryReconciliationCapability = requireCapability('inventory', 'reconcile');
const requireInventoryExportCapability = requireCapability('inventory', 'export');

const inventoryDetailInclude = {
  inventoryItem: true,
  supplier: { select: { id: true, name: true } },
} satisfies Prisma.InventoryDetailInclude;

type InventoryMutationInput = {
  partNumber?: string;
  description?: string;
  partCategory?: string;
  trackingType?: string;
  quantity?: number;
  location?: string;
  warehouse?: string;
  shelf?: string;
  conditionCode?: string;
  certificateType?: string;
  certificateNumber?: string;
  certificateFileUrl?: string;
  serialNumber?: string;
  batchNumber?: string;
  manufacturer?: string;
  manufacturerCageCode?: string;
  ataChapter?: string;
  alternatePartNumbers?: string;
  unitOfMeasure?: string;
  countryOfOrigin?: string;
  hsCode?: string;
  unitCost?: number;
  type?: string;
  supplierId?: string;
  eta?: string;
  lifeLimited?: boolean;
  totalHours?: number;
  totalCycles?: number;
  remainingHours?: number;
  remainingCycles?: number;
  manufactureDate?: string;
  shelfLifeDate?: string;
  overhaulDate?: string;
  nextOverhaulDue?: string;
  adStatus?: string;
  sbStatus?: string;
  repairScheme?: string;
  previousOperator?: string;
  removalAircraftReg?: string;
  removalDate?: string;
  removalReason?: string;
  nonIncidentStatement?: boolean;
  militarySource?: boolean;
  traceabilityDocs?: string;
  storageCondition?: string;
  ata300Packaging?: boolean;
  shelfLifeDays?: number;
  storageTempMin?: number;
  storageTempMax?: number;
  hazardClass?: string;
  notes?: string;
};

function queryText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function emptyToNull(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

function parseDate(value: string) {
  if (!value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('日期格式无效', 400, 'VALIDATION_ERROR');
  }
  return parsed;
}

function buildInventoryDetailWhere(query: Record<string, unknown>): Prisma.InventoryDetailWhereInput {
  const partNumber = queryText(query.partNumber);
  const search = queryText(query.search);
  const conditionCode = queryText(query.conditionCode);
  const certificateType = queryText(query.certificateType);
  const type = queryText(query.type);
  const partCategory = queryText(query.partCategory);
  const location = queryText(query.location);
  const itemWhere: Prisma.InventoryItemWhereInput = {};
  const where: Prisma.InventoryDetailWhereInput = {};

  if (partNumber) {
    itemWhere.partNumber = { contains: partNumber, mode: 'insensitive' };
  }
  if (partCategory) {
    itemWhere.partCategory = partCategory.toUpperCase();
  }
  if (Object.keys(itemWhere).length > 0) {
    where.inventoryItem = itemWhere;
  }
  if (search) {
    where.OR = [
      { inventoryItem: { partNumber: { contains: search, mode: 'insensitive' } } },
      { inventoryItem: { description: { contains: search, mode: 'insensitive' } } },
      { inventoryItem: { manufacturer: { contains: search, mode: 'insensitive' } } },
      { serialNumber: { contains: search, mode: 'insensitive' } },
      { batchNumber: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (conditionCode) where.conditionCode = conditionCode.toUpperCase();
  if (certificateType) where.certificateType = certificateType.toUpperCase();
  if (type) where.type = type.toUpperCase();
  if (location) where.location = location;

  return where;
}

type InventoryListSort = 'partNumber' | 'createdAt' | 'quantity' | 'unitCost';

function inventoryListOrderBy(
  sort: InventoryListSort,
  direction: SortDirection,
): Prisma.InventoryDetailOrderByWithRelationInput[] {
  switch (sort) {
    case 'createdAt':
      return [{ createdAt: direction }, { id: 'asc' }];
    case 'quantity':
      return [{ quantity: direction }, { id: 'asc' }];
    case 'unitCost':
      return [{ unitCost: direction }, { id: 'asc' }];
    default:
      return [{ inventoryItem: { partNumber: direction } }, { id: 'asc' }];
  }
}

function serializeInventoryEvent(
  action: string,
  inventory: ReturnType<typeof serializeInventoryDetail>,
  extras: Record<string, unknown> = {},
) {
  return {
    action,
    inventoryDetailId: inventory.id,
    inventoryItemId: inventory.inventoryItemId,
    partNumber: inventory.partNumber,
    quantity: inventory.quantity,
    status: inventory.status,
    conditionCode: inventory.conditionCode,
    ...extras,
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page: pageNum, limit: pageSize, skip, sort, direction } = parseListQuery<InventoryListSort>(
      req.query as Record<string, unknown>,
      {
        allowedSorts: ['partNumber', 'createdAt', 'quantity', 'unitCost'],
        defaultSort: 'partNumber',
        defaultDirection: 'asc',
      },
    );
    const where = buildInventoryDetailWhere(req.query as Record<string, unknown>);

    const [details, total, summaryRows] = await Promise.all([
      prisma.inventoryDetail.findMany({
        where,
        include: inventoryDetailInclude,
        orderBy: inventoryListOrderBy(sort, direction),
        skip,
        take: pageSize,
      }),
      prisma.inventoryDetail.count({ where }),
      prisma.inventoryDetail.findMany({
        where,
        select: {
          quantity: true,
          unitCost: true,
          location: true,
          inventoryItem: { select: { partCategory: true } },
        },
      }),
    ]);

    const categoryCount = (category: string) => summaryRows.filter(
      (row) => row.inventoryItem.partCategory === category,
    ).length;
    const summary = {
      total: summaryRows.length,
      rotable: categoryCount('ROTABLE'),
      repairable: categoryCount('REPAIRABLE'),
      chemical: categoryCount('CHEMICAL'),
      standardPart: categoryCount('STANDARD_PART'),
      rawMaterial: categoryCount('RAW_MATERIAL'),
      consumable: categoryCount('CONSUMABLE'),
      totalValue: summaryRows.reduce((sum, item) => sum + item.quantity * item.unitCost, 0),
      locations: Array.from(new Set(summaryRows.map((item) => item.location).filter(Boolean))).sort(),
    };

    res.json({
      success: true,
      data: details.map(serializeInventoryDetail),
      summary,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        sort,
        direction,
      },
    });
  }),
);

router.get(
  '/export.csv',
  requireInventoryExportCapability,
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const window = parseControlledExportWindow(query);
    const { sort, direction } = parseListQuery<InventoryListSort>(query, {
      allowedSorts: ['partNumber', 'createdAt', 'quantity', 'unitCost'],
      defaultSort: 'partNumber',
      defaultDirection: 'asc',
    });
    const details = await prisma.inventoryDetail.findMany({
      where: buildInventoryDetailWhere(query),
      include: inventoryDetailInclude,
      orderBy: inventoryListOrderBy(sort, direction),
      skip: window.skip,
      take: window.take,
    });

    await createAuditLog({
      req,
      action: 'EXPORT',
      resourceType: 'INVENTORY',
      details: `Inventory CSV export (${window.scope}, ${details.length}/${window.rowLimit} rows)`,
    });
    sendCsv(
      res,
      `inventory-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { header: '件号', value: (detail) => detail.inventoryItem.partNumber },
        { header: '描述', value: (detail) => detail.inventoryItem.description },
        { header: '序列号', value: (detail) => detail.serialNumber },
        { header: '批次号', value: (detail) => detail.batchNumber },
        { header: '数量', value: (detail) => detail.quantity },
        { header: '状态', value: (detail) => detail.status },
        { header: '条件', value: (detail) => detail.conditionCode },
        { header: '证书类型', value: (detail) => detail.certificateType },
        { header: '位置', value: (detail) => detail.location },
        { header: '库存类型', value: (detail) => detail.type },
        { header: '类别', value: (detail) => detail.inventoryItem.partCategory },
        { header: '单位成本', value: (detail) => detail.unitCost },
        { header: '供应商', value: (detail) => detail.supplier?.name },
        { header: '创建时间', value: (detail) => detail.createdAt },
      ],
      details,
      window,
    );
  }),
);

router.get(
  '/reconciliation',
  requireInventoryReconciliationCapability,
  asyncHandler(async (_req, res) => {
    try {
      const result = await loadInventoryReconciliation();
      res.json({
        success: true,
        data: {
          ...result,
          status: result.mismatches.length === 0 ? 'PASS' : 'MISMATCH',
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
        throw new AppError('库存对账依赖的表尚未就绪', 503, 'BAD_REQUEST');
      }
      throw error;
    }
  }),
);

router.get(
  '/part/:partNumber',
  asyncHandler(async (req, res) => {
    const details = await prisma.inventoryDetail.findMany({
      where: { inventoryItem: { partNumber: req.params.partNumber } },
      include: inventoryDetailInclude,
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: details.map(serializeInventoryDetail),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const detail = await prisma.inventoryDetail.findUnique({
      where: { id: req.params.id },
      include: inventoryDetailInclude,
    });

    if (!detail) {
      throw new AppError('库存不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({ success: true, data: serializeInventoryDetail(detail) });
  }),
);

router.post(
  '/',
  requireInventoryMutationRole,
  validateBody(inventoryCreateSchema),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = req.body as InventoryMutationInput;
    const actorId = req.user!.id;
    const quantity = input.quantity ?? 0;

    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/inventory'),
      async (tx) => {
        const item = await tx.inventoryItem.upsert({
          where: { partNumber: input.partNumber! },
          create: {
            partNumber: input.partNumber!,
            description: input.description!,
            partCategory: input.partCategory?.toUpperCase() ?? 'CONSUMABLE',
            trackingType: input.trackingType?.toUpperCase() ?? 'BATCH',
            manufacturer: input.manufacturer || null,
            manufacturerCageCode: input.manufacturerCageCode || null,
            ataChapter: input.ataChapter || null,
            alternatePartNumbers: input.alternatePartNumbers || null,
            unitOfMeasure: input.unitOfMeasure?.toUpperCase() ?? 'EA',
            countryOfOrigin: input.countryOfOrigin || null,
            hsCode: input.hsCode || null,
          },
          // A stock receipt must not silently overwrite the part master shared
          // by other details. Master changes go through PATCH /inventory/:id.
          update: {},
        });

        const detail = await tx.inventoryDetail.create({
          data: {
            inventoryItemId: item.id,
            serialNumber: input.serialNumber ? emptyToNull(input.serialNumber) : null,
            batchNumber: input.batchNumber ? emptyToNull(input.batchNumber) : null,
            quantity,
            conditionCode: input.conditionCode?.toUpperCase() ?? 'NE',
            status: 'AVAILABLE',
            warehouse: input.warehouse ? emptyToNull(input.warehouse) : null,
            shelf: input.shelf ? emptyToNull(input.shelf) : null,
            location: input.location!,
            certificateType: input.certificateType?.toUpperCase() ?? 'NONE',
            certificateNumber: input.certificateNumber ? emptyToNull(input.certificateNumber) : null,
            certificateFileUrl: input.certificateFileUrl ? emptyToNull(input.certificateFileUrl) : null,
            lifeLimited: input.lifeLimited ?? false,
            totalHours: input.totalHours ?? null,
            totalCycles: input.totalCycles ?? null,
            remainingHours: input.remainingHours ?? null,
            remainingCycles: input.remainingCycles ?? null,
            manufactureDate: input.manufactureDate ? parseDate(input.manufactureDate) : null,
            shelfLifeDate: input.shelfLifeDate ? parseDate(input.shelfLifeDate) : null,
            overhaulDate: input.overhaulDate ? parseDate(input.overhaulDate) : null,
            nextOverhaulDue: input.nextOverhaulDue ? parseDate(input.nextOverhaulDue) : null,
            adStatus: input.adStatus ? emptyToNull(input.adStatus) : null,
            sbStatus: input.sbStatus ? emptyToNull(input.sbStatus) : null,
            repairScheme: input.repairScheme ? emptyToNull(input.repairScheme) : null,
            previousOperator: input.previousOperator ? emptyToNull(input.previousOperator) : null,
            removalAircraftReg: input.removalAircraftReg ? emptyToNull(input.removalAircraftReg) : null,
            removalDate: input.removalDate ? parseDate(input.removalDate) : null,
            removalReason: input.removalReason ? emptyToNull(input.removalReason) : null,
            nonIncidentStatement: input.nonIncidentStatement ?? false,
            militarySource: input.militarySource ?? false,
            traceabilityDocs: input.traceabilityDocs ? emptyToNull(input.traceabilityDocs) : null,
            storageCondition: input.storageCondition ? emptyToNull(input.storageCondition) : null,
            ata300Packaging: input.ata300Packaging ?? false,
            shelfLifeDays: input.shelfLifeDays ?? null,
            storageTempMin: input.storageTempMin ?? null,
            storageTempMax: input.storageTempMax ?? null,
            hazardClass: input.hazardClass ? emptyToNull(input.hazardClass) : null,
            unitCost: input.unitCost ?? 0,
            supplierId: input.supplierId ? emptyToNull(input.supplierId) : null,
            eta: input.eta ? parseDate(input.eta) : null,
            type: input.type?.toUpperCase() ?? 'OWN',
          },
          include: inventoryDetailInclude,
        });

        if (quantity > 0) {
          await tx.inventoryTransaction.create({
            data: {
              inventoryDetailId: detail.id,
              type: 'INBOUND',
              quantity,
              beforeQuantity: 0,
              afterQuantity: quantity,
              referenceType: 'MANUAL',
              notes: input.notes?.trim() || 'Manual inventory receipt.',
              createdBy: actorId,
            },
          });
        }

        const payload = serializeInventoryDetail(detail);
        await enqueueBusinessEvent(tx, {
          eventType: 'inventory.created',
          aggregateType: 'INVENTORY_DETAIL',
          aggregateId: detail.id,
          data: serializeInventoryEvent('created', payload),
          socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
          createdById: actorId,
        });

        return {
          payload,
          statusCode: 201,
          resourceType: 'INVENTORY_DETAIL',
          resourceId: detail.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  }),
);

router.patch(
  '/:id',
  requireInventoryMutationRole,
  validateBody(inventoryUpdateSchema),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = req.body as InventoryMutationInput;
    const actorId = req.user!.id;

    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'PATCH:/inventory/:id'),
      async (tx) => {
        const existing = await tx.inventoryDetail.findUnique({
          where: { id: req.params.id },
          include: inventoryDetailInclude,
        });
        if (!existing) {
          throw new AppError('库存不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (input.quantity !== undefined && existing.status !== 'AVAILABLE') {
          throw new AppError('预留或隔离库存不能直接调整数量', 409, 'RESOURCE_CONFLICT');
        }

        const itemData: Prisma.InventoryItemUpdateInput = {
          ...(input.description !== undefined && { description: input.description }),
          ...(input.partCategory !== undefined && { partCategory: input.partCategory.toUpperCase() }),
          ...(input.trackingType !== undefined && { trackingType: input.trackingType.toUpperCase() }),
          ...(input.manufacturer !== undefined && { manufacturer: emptyToNull(input.manufacturer) }),
          ...(input.manufacturerCageCode !== undefined && { manufacturerCageCode: emptyToNull(input.manufacturerCageCode) }),
          ...(input.ataChapter !== undefined && { ataChapter: emptyToNull(input.ataChapter) }),
          ...(input.alternatePartNumbers !== undefined && { alternatePartNumbers: emptyToNull(input.alternatePartNumbers) }),
          ...(input.unitOfMeasure !== undefined && { unitOfMeasure: input.unitOfMeasure.toUpperCase() }),
          ...(input.countryOfOrigin !== undefined && { countryOfOrigin: emptyToNull(input.countryOfOrigin) }),
          ...(input.hsCode !== undefined && { hsCode: emptyToNull(input.hsCode) }),
        };
        if (Object.keys(itemData).length > 0) {
          await tx.inventoryItem.update({ where: { id: existing.inventoryItemId }, data: itemData });
        }

        const detailData: Prisma.InventoryDetailUncheckedUpdateInput = {
          ...(input.quantity !== undefined && { quantity: input.quantity }),
          ...(input.location !== undefined && { location: input.location }),
          ...(input.warehouse !== undefined && { warehouse: emptyToNull(input.warehouse) }),
          ...(input.shelf !== undefined && { shelf: emptyToNull(input.shelf) }),
          ...(input.conditionCode !== undefined && { conditionCode: input.conditionCode.toUpperCase() }),
          ...(input.certificateType !== undefined && { certificateType: input.certificateType.toUpperCase() }),
          ...(input.certificateNumber !== undefined && { certificateNumber: emptyToNull(input.certificateNumber) }),
          ...(input.certificateFileUrl !== undefined && { certificateFileUrl: emptyToNull(input.certificateFileUrl) }),
          ...(input.serialNumber !== undefined && { serialNumber: emptyToNull(input.serialNumber) }),
          ...(input.batchNumber !== undefined && { batchNumber: emptyToNull(input.batchNumber) }),
          ...(input.unitCost !== undefined && { unitCost: input.unitCost }),
          ...(input.type !== undefined && { type: input.type.toUpperCase() }),
          ...(input.supplierId !== undefined && { supplierId: emptyToNull(input.supplierId) }),
          ...(input.eta !== undefined && { eta: parseDate(input.eta) }),
          ...(input.lifeLimited !== undefined && { lifeLimited: input.lifeLimited }),
          ...(input.totalHours !== undefined && { totalHours: input.totalHours }),
          ...(input.totalCycles !== undefined && { totalCycles: input.totalCycles }),
          ...(input.remainingHours !== undefined && { remainingHours: input.remainingHours }),
          ...(input.remainingCycles !== undefined && { remainingCycles: input.remainingCycles }),
          ...(input.manufactureDate !== undefined && { manufactureDate: parseDate(input.manufactureDate) }),
          ...(input.shelfLifeDate !== undefined && { shelfLifeDate: parseDate(input.shelfLifeDate) }),
          ...(input.overhaulDate !== undefined && { overhaulDate: parseDate(input.overhaulDate) }),
          ...(input.nextOverhaulDue !== undefined && { nextOverhaulDue: parseDate(input.nextOverhaulDue) }),
          ...(input.adStatus !== undefined && { adStatus: emptyToNull(input.adStatus) }),
          ...(input.sbStatus !== undefined && { sbStatus: emptyToNull(input.sbStatus) }),
          ...(input.repairScheme !== undefined && { repairScheme: emptyToNull(input.repairScheme) }),
          ...(input.previousOperator !== undefined && { previousOperator: emptyToNull(input.previousOperator) }),
          ...(input.removalAircraftReg !== undefined && { removalAircraftReg: emptyToNull(input.removalAircraftReg) }),
          ...(input.removalDate !== undefined && { removalDate: parseDate(input.removalDate) }),
          ...(input.removalReason !== undefined && { removalReason: emptyToNull(input.removalReason) }),
          ...(input.nonIncidentStatement !== undefined && { nonIncidentStatement: input.nonIncidentStatement }),
          ...(input.militarySource !== undefined && { militarySource: input.militarySource }),
          ...(input.traceabilityDocs !== undefined && { traceabilityDocs: emptyToNull(input.traceabilityDocs) }),
          ...(input.storageCondition !== undefined && { storageCondition: emptyToNull(input.storageCondition) }),
          ...(input.ata300Packaging !== undefined && { ata300Packaging: input.ata300Packaging }),
          ...(input.shelfLifeDays !== undefined && { shelfLifeDays: input.shelfLifeDays }),
          ...(input.storageTempMin !== undefined && { storageTempMin: input.storageTempMin }),
          ...(input.storageTempMax !== undefined && { storageTempMax: input.storageTempMax }),
          ...(input.hazardClass !== undefined && { hazardClass: emptyToNull(input.hazardClass) }),
        };
        const updated = await tx.inventoryDetail.update({
          where: { id: existing.id },
          data: detailData,
          include: inventoryDetailInclude,
        });

        const quantityDelta = input.quantity === undefined ? 0 : input.quantity - existing.quantity;
        if (quantityDelta !== 0) {
          await tx.inventoryTransaction.create({
            data: {
              inventoryDetailId: updated.id,
              type: 'ADJUSTMENT',
              quantity: quantityDelta,
              beforeQuantity: existing.quantity,
              afterQuantity: updated.quantity,
              referenceType: 'MANUAL',
              notes: input.notes?.trim() || 'Manual inventory adjustment.',
              createdBy: actorId,
            },
          });
        }

        const payload = serializeInventoryDetail(updated);
        await enqueueBusinessEvent(tx, {
          eventType: quantityDelta === 0 ? 'inventory.updated' : 'inventory.adjusted',
          aggregateType: 'INVENTORY_DETAIL',
          aggregateId: updated.id,
          data: serializeInventoryEvent(
            quantityDelta === 0 ? 'updated' : 'adjusted',
            payload,
            quantityDelta === 0 ? {} : { beforeQuantity: existing.quantity, quantityDelta },
          ),
          socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
          createdById: actorId,
        });

        return {
          payload,
          resourceType: 'INVENTORY_DETAIL',
          resourceId: updated.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  }),
);

router.delete(
  '/:id',
  requireInventoryMutationRole,
  asyncHandler(async (req: AuthRequest, res) => {
    const actorId = req.user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'DELETE:/inventory/:id'),
      async (tx) => {
        const detail = await tx.inventoryDetail.findUnique({
          where: { id: req.params.id },
          include: inventoryDetailInclude,
        });
        if (!detail) {
          throw new AppError('库存不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (detail.quantity !== 0) {
          throw new AppError('库存数量不为零，不能物理删除；请先通过调整流水清零', 409, 'RESOURCE_CONFLICT');
        }

        const [legacyRecord, transaction, certificate] = await Promise.all([
          tx.inventory.findUnique({ where: { id: detail.id } }),
          tx.inventoryTransaction.findFirst({ where: { inventoryDetailId: detail.id } }),
          tx.certificate.findFirst({ where: { inventoryDetailId: detail.id } }),
        ]);
        if (legacyRecord) {
          throw new AppError('迁移自旧库存的记录只读保留，请使用隔离或报废状态归档', 409, 'RESOURCE_CONFLICT');
        }
        if (transaction || certificate) {
          throw new AppError('库存明细已有流水或证书关联，不能物理删除', 409, 'RESOURCE_CONFLICT');
        }

        const payload = serializeInventoryDetail(detail);
        await tx.inventoryDetail.delete({ where: { id: detail.id } });
        const remainingDetails = await tx.inventoryDetail.count({ where: { inventoryItemId: detail.inventoryItemId } });
        if (remainingDetails === 0) {
          await tx.inventoryItem.delete({ where: { id: detail.inventoryItemId } });
        }

        await enqueueBusinessEvent(tx, {
          eventType: 'inventory.deleted',
          aggregateType: 'INVENTORY_DETAIL',
          aggregateId: detail.id,
          data: serializeInventoryEvent('deleted', payload),
          socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
          createdById: actorId,
        });

        return {
          payload: { id: detail.id, deleted: true },
          resourceType: 'INVENTORY_DETAIL',
          resourceId: detail.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  }),
);

export default router;
