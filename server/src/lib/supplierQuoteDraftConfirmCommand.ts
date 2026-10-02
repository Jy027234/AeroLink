import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertCapability } from '../middleware/capability.js';
import { buildRfqReadScope } from './rfqAccess.js';
import { getCapabilityScope } from './capabilityPolicy.js';
import {
  compareQuantityUnits,
  supplierQuoteDraftConfirmItemSchema,
  supplierQuoteDraftPayloadSchema,
} from './validation.js';
import { calculateMoneyTotal, normalizeMoney } from './money.js';
import { resolveSupplierQuoteSourceBinding } from './supplierQuoteSourceBinding.js';
import { toSupplierQuoteStatusEnum } from './transactionStatusShadows.js';
import { VERIFIED_CURRENCY_STATUS } from './commercialCostSource.js';
import { captureSourcingAiTaskSourceFingerprint, SUPPLIER_QUOTE_EXTRACTION_TASK } from './sourcingAiTaskService.js';
import prisma from './prisma.js';

type SupplierQuoteDraftActor = NonNullable<AuthRequest['user']>;
type DraftSecurityClient = Pick<Prisma.TransactionClient, 'inquiry' | 'rFQ' | 'inquiryEmailLink'>;
type DraftSource = { id: string; emailId: string; inquiryId: string };

type ConfirmSupplierQuoteDraftData = {
  draftId: string;
  status: 'PARTIALLY_CONFIRMED' | 'CONFIRMED';
  version: number;
  reused: boolean;
  confirmedItemKeys: string[];
  confirmedQuotes: Array<{ itemKey: string; quoteId: string }>;
  supplierQuoteIds: string[];
  createdSupplierQuoteIds: string[];
  reusedSupplierQuoteIds: string[];
  supplierQuotes: Prisma.SupplierQuoteGetPayload<Record<string, never>>[];
};

async function assertRfqReadAccess(
  actor: SupplierQuoteDraftActor,
  rfqId: string | null,
  client: DraftSecurityClient,
) {
  assertCapability(actor, 'rfq', 'read');
  if (!rfqId) {
    // Match inquiryReadScope: unbound legacy inquiries are visible only to all-scope readers.
    if (getCapabilityScope(actor, 'rfq.read') === 'all') return;
    throw new AppError('无法核验无 RFQ 关联的历史询价权限', 404, 'RESOURCE_NOT_FOUND');
  }

  const rfq = await client.rFQ.findFirst({
    where: { AND: [{ id: rfqId }, buildRfqReadScope(actor)] },
    select: { id: true, createdBy: true, creator: { select: { department: true } } },
  });
  if (!rfq) throw new AppError('关联 RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
  assertCapability(actor, 'rfq', 'read', { ownerId: rfq.createdBy, department: rfq.creator?.department });
}

async function assertDraftSourceAccess(
  actor: SupplierQuoteDraftActor,
  emailId: string,
  inquiryId: string,
  client: DraftSecurityClient,
) {
  const inquiry = await client.inquiry.findUnique({
    where: { id: inquiryId },
    select: { id: true, rfqId: true, supplierId: true },
  });
  if (!inquiry) throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertRfqReadAccess(actor, inquiry.rfqId, client);

  const link = await client.inquiryEmailLink.findUnique({
    where: { emailId_inquiryId: { emailId, inquiryId } },
    select: { confirmationStatus: true },
  });
  if (!link || link.confirmationStatus !== 'CONFIRMED') {
    throw new AppError('请先人工确认邮件与询价单的关联', 409, 'STATE_CONFLICT');
  }
  return inquiry;
}

function parseDraftPayload(payloadJson: string) {
  let value: unknown;
  try { value = JSON.parse(payloadJson); } catch {
    throw new AppError('报价草稿内容无法读取，请重新编辑后再确认', 409, 'STATE_CONFLICT');
  }
  const parsed = supplierQuoteDraftPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('报价草稿内容无法读取，请重新编辑后再确认', 409, 'STATE_CONFLICT');
  }
  return parsed.data;
}

function selectedItemKeys(payload: ReturnType<typeof parseDraftPayload>, requested?: string[]) {
  const payloadKeys = payload.items.map((item) => item.itemKey).filter((key): key is string => Boolean(key));
  if (!requested) {
    if (payloadKeys.length !== payload.items.length) {
      throw new AppError('报价草稿行标识缺失，请重新编辑后再确认', 409, 'STATE_CONFLICT');
    }
    return payloadKeys;
  }
  const available = new Set(payloadKeys);
  const unknown = requested.find((key) => !available.has(key));
  if (unknown) throw new AppError('所选报价草稿行已不存在，请重新加载', 409, 'STATE_CONFLICT');
  return requested;
}

function confirmableItems(payload: ReturnType<typeof parseDraftPayload>, itemKeys: string[]) {
  const byKey = new Map(payload.items.flatMap((item) => item.itemKey ? [[item.itemKey, item] as const] : []));
  return itemKeys.map((itemKey) => {
    const item = byKey.get(itemKey);
    const parsed = supplierQuoteDraftConfirmItemSchema.safeParse(item);
    if (!parsed.success) {
      throw new AppError('报价草稿仍有缺项或交期范围未归一，请补全询价项、件号、数量、数量单位、USD 单价和单一交期后再确认', 409, 'VALIDATION_ERROR');
    }
    return parsed.data;
  });
}

function isRetryableTransactionConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code);
}

function isDraftClaimConflict(error: unknown) {
  return error instanceof AppError
    && error.code === 'STATE_CONFLICT'
    && error.message === '报价草稿已被其他用户确认或修改';
}

async function assertCompletedExtractionTaskSource(
  actor: SupplierQuoteDraftActor,
  taskId: string,
  draft: DraftSource,
  client: Prisma.TransactionClient,
) {
  const admin = ['admin', 'administrator'].includes(actor.role.toLowerCase());
  const task = await client.sourcingAiTask.findFirst({
    where: { id: taskId, ...(admin ? {} : { actorId: actor.id }) },
    select: {
      actorId: true, type: true, emailId: true, inquiryId: true,
      status: true, draftId: true, sourceFingerprint: true,
    },
  });
  if (!task) throw new AppError('任务不存在', 404, 'RESOURCE_NOT_FOUND');
  if (task.type !== SUPPLIER_QUOTE_EXTRACTION_TASK || task.status !== 'COMPLETED'
    || task.draftId !== draft.id || task.emailId !== draft.emailId || task.inquiryId !== draft.inquiryId) {
    throw new AppError('任务与待确认报价草稿不匹配，请重新加载', 409, 'STATE_CONFLICT');
  }
  if (!task.sourceFingerprint) {
    throw new AppError('任务未记录来源版本，请重新创建任务', 409, 'STATE_CONFLICT');
  }
  const currentSource = await captureSourcingAiTaskSourceFingerprint(actor.id, task.emailId, task.inquiryId, client);
  if (currentSource !== task.sourceFingerprint) {
    throw new AppError('任务来源已变化，请重新创建提取任务', 409, 'STATE_CONFLICT');
  }
  if (actor.id !== task.actorId) {
    const ownerSource = await captureSourcingAiTaskSourceFingerprint(task.actorId, task.emailId, task.inquiryId, client);
    if (ownerSource !== task.sourceFingerprint) {
      throw new AppError('任务来源已变化，请重新创建提取任务', 409, 'STATE_CONFLICT');
    }
  }
}

function toResponseData(
  draft: { id: string; status: string; version: number },
  quotes: Prisma.SupplierQuoteGetPayload<Record<string, never>>[],
  createdQuoteIds: string[],
): ConfirmSupplierQuoteDraftData {
  const supplierQuoteIds = quotes.map((quote) => quote.id);
  const createdQuoteIdSet = new Set(createdQuoteIds);
  const confirmedQuotes = quotes.flatMap((quote) => quote.sourceDraftItemKey
    ? [{ itemKey: quote.sourceDraftItemKey, quoteId: quote.id }]
    : []);
  return {
    draftId: draft.id,
    status: draft.status === 'CONFIRMED' ? 'CONFIRMED' : 'PARTIALLY_CONFIRMED',
    version: draft.version,
    reused: createdQuoteIds.length === 0,
    confirmedItemKeys: confirmedQuotes.map((quote) => quote.itemKey),
    confirmedQuotes,
    supplierQuoteIds,
    createdSupplierQuoteIds: createdQuoteIds,
    reusedSupplierQuoteIds: supplierQuoteIds.filter((id) => !createdQuoteIdSet.has(id)),
    supplierQuotes: quotes,
  };
}

/**
 * Confirm a supplier quote draft through the shared, authorization-aware business command.
 * The caller supplies the current actor and the version the user reviewed; this
 * command revalidates capability, source provenance, and version in the write transaction.
 */
export async function confirmSupplierQuoteDraftCommand(
  actor: SupplierQuoteDraftActor,
  draftId: string,
  expectedVersion: number,
  options: { sourcingAiTaskId?: string; itemKeys?: string[] } = {},
): Promise<ConfirmSupplierQuoteDraftData> {
  assertCapability(actor, 'email', 'read');
  assertCapability(actor, 'supplier_quote', 'create');
  assertCapability(actor, 'supplier_quote', 'update');

  try {
    const result = await prisma.$transaction(async (tx) => {
      const draft = await tx.supplierQuoteDraft.findUnique({
        where: { id: draftId },
        select: {
          id: true,
          emailId: true,
          inquiryId: true,
          supplierId: true,
          status: true,
          version: true,
          payloadJson: true,
        },
      });
      if (!draft) throw new AppError('供应商报价草稿不存在', 404, 'RESOURCE_NOT_FOUND');
      if (options.sourcingAiTaskId) {
        await assertCompletedExtractionTaskSource(actor, options.sourcingAiTaskId, draft, tx);
      }
      const scopedInquiry = await assertDraftSourceAccess(actor, draft.emailId, draft.inquiryId, tx);
      if (scopedInquiry.supplierId !== draft.supplierId) {
        throw new AppError('报价草稿与询价供应商不一致，不能确认', 409, 'RESOURCE_CONFLICT');
      }
      if (!['DRAFT', 'PARTIALLY_CONFIRMED', 'CONFIRMED'].includes(draft.status)) {
        throw new AppError('当前报价草稿状态不能确认', 409, 'STATE_CONFLICT');
      }

      const payload = parseDraftPayload(draft.payloadJson);
      const requestedItemKeys = selectedItemKeys(payload, options.itemKeys);
      const existingQuotes = await tx.supplierQuote.findMany({
        where: { sourceDraftId: draft.id },
        orderBy: { sourceDraftItemKey: 'asc' },
      });
      const existingItemKeys = new Set(existingQuotes
        .map((quote) => quote.sourceDraftItemKey)
        .filter((itemKey): itemKey is string => Boolean(itemKey)));
      const unconfirmedItemKeys = requestedItemKeys.filter((itemKey) => !existingItemKeys.has(itemKey));
      if (draft.version !== expectedVersion) {
        if ((draft.status === 'PARTIALLY_CONFIRMED' || draft.status === 'CONFIRMED')
          && requestedItemKeys.every((itemKey) => existingItemKeys.has(itemKey))) {
          return { draft, quotes: existingQuotes, createdQuoteIds: [] };
        }
        throw new AppError('报价草稿版本已变化，请重新加载后确认', 409, 'STATE_CONFLICT');
      }
      if (draft.status === 'CONFIRMED') {
        if (existingQuotes.length === 0 || unconfirmedItemKeys.length > 0) {
          throw new AppError('已确认草稿缺少报价记录，请联系管理员', 409, 'STATE_CONFLICT');
        }
        return { draft, quotes: existingQuotes, createdQuoteIds: [] };
      }

      const [link, email, inquiry] = await Promise.all([
        tx.inquiryEmailLink.findUnique({
          where: { emailId_inquiryId: { emailId: draft.emailId, inquiryId: draft.inquiryId } },
          select: { confirmationStatus: true },
        }),
        tx.email.findUnique({ where: { id: draft.emailId }, select: { id: true } }),
        tx.inquiry.findUnique({
          where: { id: draft.inquiryId },
          select: { id: true, rfqId: true, supplierId: true },
        }),
      ]);
      if (!link || link.confirmationStatus !== 'CONFIRMED' || !email) {
        throw new AppError('邮件与询价单的人工关联已失效，不能确认报价', 409, 'STATE_CONFLICT');
      }
      if (!inquiry || inquiry.supplierId !== draft.supplierId) {
        throw new AppError('报价草稿与询价供应商不一致，不能确认', 409, 'RESOURCE_CONFLICT');
      }

      if (unconfirmedItemKeys.length === 0) {
        if (existingQuotes.length === 0) throw new AppError('报价草稿尚无已确认行', 409, 'STATE_CONFLICT');
        return { draft, quotes: existingQuotes, createdQuoteIds: [] };
      }

      const itemsToConfirm = confirmableItems(payload, unconfirmedItemKeys);
      const itemIds = [...new Set(itemsToConfirm.map((item) => item.inquiryItemId))];
      const inquiryItems = await tx.inquiryItem.findMany({
        where: { inquiryId: inquiry.id, id: { in: itemIds } },
        select: { id: true, inquiryId: true, rfqLineId: true, partNumber: true, quantity: true },
      });
      const inquiryItemsById = new Map(inquiryItems.map((item) => [item.id, item]));
      if (inquiryItemsById.size !== itemIds.length) {
        throw new AppError('报价草稿包含不属于当前询价单的需求项', 409, 'RESOURCE_CONFLICT');
      }
      const sourceBindings = new Map<string, Awaited<ReturnType<typeof resolveSupplierQuoteSourceBinding>>>();
      for (const item of itemsToConfirm) {
        const inquiryItem = inquiryItemsById.get(item.inquiryItemId);
        if (!inquiryItem || inquiryItem.partNumber !== item.partNumber) {
          throw new AppError('报价件号必须与选定的询价需求项完全一致', 409, 'RESOURCE_CONFLICT');
        }
        if (item.quantity > inquiryItem.quantity) {
          throw new AppError('报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
        }
        const source = await resolveSupplierQuoteSourceBinding(tx, {
          rfqId: inquiry.rfqId,
          rfqLineId: inquiryItem.rfqLineId,
          inquiryId: inquiry.id,
          inquiryItemId: item.inquiryItemId,
          supplierId: draft.supplierId,
          partNumber: item.partNumber,
          quantity: item.quantity,
        });
        const demand = source.rfqLineId
          ? await tx.rfqLine.findUnique({ where: { id: source.rfqLineId }, select: { uom: true } })
          : source.rfqId
            ? await tx.rFQ.findUnique({ where: { id: source.rfqId }, select: { uom: true } })
            : null;
        const unitComparison = compareQuantityUnits(item.quantityUnit, demand?.uom ?? null);
        if (!unitComparison.compatible) {
          const message = unitComparison.reason === 'DEMAND_UNIT_UNKNOWN'
            ? '询价需求单位未知，不能确认供应商报价'
            : unitComparison.reason === 'UNIT_MISMATCH'
              ? '供应商报价数量单位与询价需求单位不兼容，不能确认'
              : '确认报价必须明确数量单位';
          throw new AppError(message, 409, 'RESOURCE_CONFLICT');
        }
        sourceBindings.set(item.itemKey, source);
      }

      const confirmedItemKeys = new Set([...existingItemKeys, ...unconfirmedItemKeys]);
      const everyDraftRowConfirmed = payload.items.every((item) =>
        Boolean(item.itemKey) && confirmedItemKeys.has(item.itemKey!));
      const nextStatus = everyDraftRowConfirmed ? 'CONFIRMED' : 'PARTIALLY_CONFIRMED';
      const confirmedAt = new Date();
      const claimed = await tx.supplierQuoteDraft.updateMany({
        where: { id: draft.id, status: draft.status, version: expectedVersion },
        data: {
          status: nextStatus,
          version: { increment: 1 },
          ...(nextStatus === 'CONFIRMED' ? { confirmedAt, confirmedById: actor.id } : {}),
        },
      });
      if (claimed.count !== 1) {
        throw new AppError('报价草稿已被其他用户确认或修改', 409, 'STATE_CONFLICT');
      }

      const createdQuotes: Prisma.SupplierQuoteGetPayload<Record<string, never>>[] = [];
      for (const item of itemsToConfirm) {
        const source = sourceBindings.get(item.itemKey)!;
        const unitPriceDecimal = normalizeMoney(item.unitPrice);
        const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, item.quantity);
        const quote = await tx.supplierQuote.create({
          data: {
            sourceDraftId: draft.id,
            sourceDraftItemKey: item.itemKey,
            rfqId: source.rfqId,
            rfqLineId: source.rfqLineId,
            inquiryId: source.inquiryId,
            inquiryItemId: source.inquiryItemId,
            supplierId: draft.supplierId,
            partNumber: item.partNumber,
            description: item.description ?? null,
            quantity: item.quantity,
            quantityUnit: item.quantityUnit,
            unitPrice: unitPriceDecimal.toNumber(),
            unitPriceDecimal,
            totalPrice: totalPriceDecimal.toNumber(),
            totalPriceDecimal,
            currency: 'USD',
            currencyReviewStatus: VERIFIED_CURRENCY_STATUS,
            leadTimeDays: item.leadTimeDays,
            validUntil: item.validUntil ? new Date(item.validUntil + 'T23:59:59.999Z') : null,
            notes: item.notes ?? null,
            status: 'pending',
            statusEnum: toSupplierQuoteStatusEnum('pending')!,
          },
        });
        createdQuotes.push(quote);
      }
      const createdQuoteIds = createdQuotes.map((quote) => quote.id);
      await tx.auditLog.create({
        data: {
          userId: actor.id,
          userName: actor.name || null,
          userRole: actor.role,
          action: 'CONFIRM',
          resourceType: 'SUPPLIER_QUOTE_DRAFT',
          resourceId: draft.id,
          status: 'SUCCESS',
          changes: JSON.stringify({
            version: { before: expectedVersion, after: expectedVersion + 1 },
            status: { before: draft.status, after: nextStatus },
            itemKeys: itemsToConfirm.map((item) => item.itemKey),
            supplierQuoteIds: createdQuoteIds,
          }),
          details: 'Human confirmed supplier quote draft rows',
        },
      });
      const quotes = await tx.supplierQuote.findMany({
        where: { sourceDraftId: draft.id },
        orderBy: { sourceDraftItemKey: 'asc' },
      });
      return { draft: { ...draft, status: nextStatus, version: expectedVersion + 1 }, quotes, createdQuoteIds };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return toResponseData(result.draft, result.quotes, result.createdQuoteIds);
  } catch (error) {
    if (!isRetryableTransactionConflict(error) && !isDraftClaimConflict(error)) throw error;
    const draft = await prisma.supplierQuoteDraft.findUnique({
      where: { id: draftId },
      select: { id: true, emailId: true, inquiryId: true, supplierId: true, status: true, version: true, payloadJson: true },
    });
    if (!draft || !['PARTIALLY_CONFIRMED', 'CONFIRMED'].includes(draft.status)
      || (draft.version !== expectedVersion && draft.version !== expectedVersion + 1)) throw error;
    if (options.sourcingAiTaskId) {
      await prisma.$transaction((tx) => assertCompletedExtractionTaskSource(actor, options.sourcingAiTaskId!, draft, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }
    const inquiry = await assertDraftSourceAccess(actor, draft.emailId, draft.inquiryId, prisma);
    if (inquiry.supplierId !== draft.supplierId) {
      throw new AppError('报价草稿与询价供应商不一致，不能确认', 409, 'RESOURCE_CONFLICT');
    }
    const payload = parseDraftPayload(draft.payloadJson);
    const requestedKeys = selectedItemKeys(payload, options.itemKeys);
    const quotes = await prisma.supplierQuote.findMany({
      where: { sourceDraftId: draft.id },
      orderBy: { sourceDraftItemKey: 'asc' },
    });
    const currentKeys = new Set(quotes.map((quote) => quote.sourceDraftItemKey).filter((key): key is string => Boolean(key)));
    if (!quotes.length || requestedKeys.some((key) => !currentKeys.has(key))) throw error;
    return toResponseData(draft, quotes, []);
  }
}

export { assertDraftSourceAccess, assertRfqReadAccess };
