import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import {
  supplierQuoteDraftConfirmPayloadSchema,
  supplierQuoteDraftConfirmSchema,
  supplierQuoteDraftCreateSchema,
  supplierQuoteDraftExtractSchema,
  supplierQuoteDraftPatchSchema,
  supplierQuoteDraftPayloadSchema,
} from '../lib/validation.js';
import { extractSupplierQuoteEmail } from '../lib/aiService.js';
import { calculateMoneyTotal, normalizeMoney } from '../lib/money.js';
import { resolveSupplierQuoteSourceBinding } from '../lib/supplierQuoteSourceBinding.js';
import { toSupplierQuoteStatusEnum } from '../lib/transactionStatusShadows.js';
import { VERIFIED_CURRENCY_STATUS } from '../lib/commercialCostSource.js';
import prisma from '../lib/prisma.js';

const router = Router();

const supplierQuoteDraftInclude = {
  email: {
    select: {
      id: true,
      from: true,
      fromName: true,
      subject: true,
      receivedAt: true,
      attachmentRecords: {
        orderBy: { createdAt: 'asc' },
        include: { storedObject: { select: { id: true, status: true } } },
      },
    },
  },
  inquiry: {
    select: {
      id: true,
      inquiryNumber: true,
      supplierId: true,
      items: { orderBy: { lineNo: 'asc' }, select: { id: true, partNumber: true, quantity: true, rfqLineId: true } },
    },
  },
  supplier: { select: { id: true, name: true, email: true } },
  supplierQuotes: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      sourceDraftItemKey: true,
      inquiryItemId: true,
      partNumber: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      currency: true,
      leadTimeDays: true,
      validUntil: true,
      status: true,
      createdAt: true,
    },
  },
} satisfies Prisma.SupplierQuoteDraftInclude;

type SupplierQuoteDraftRecord = Prisma.SupplierQuoteDraftGetPayload<{
  include: typeof supplierQuoteDraftInclude;
}>;

type DraftPayload = ReturnType<typeof supplierQuoteDraftPayloadSchema.parse>;

function parseStoredDraftPayload(payloadJson: string): DraftPayload {
  try {
    return supplierQuoteDraftPayloadSchema.parse(JSON.parse(payloadJson));
  } catch {
    throw new AppError('报价草稿内容无法读取，请重新编辑后再试', 409, 'STATE_CONFLICT');
  }
}

function withStableItemKeys(payload: DraftPayload): DraftPayload {
  return {
    items: payload.items.map((item) => ({
      ...item,
      itemKey: item.itemKey || randomUUID(),
    })),
  };
}

function serializeSupplierQuoteDraft(draft: SupplierQuoteDraftRecord) {
  const payload = parseStoredDraftPayload(draft.payloadJson);
  let aiMetadata: unknown = null;
  if (draft.aiMetadataJson) {
    try { aiMetadata = JSON.parse(draft.aiMetadataJson); } catch { aiMetadata = null; }
  }
  return {
    id: draft.id,
    emailId: draft.emailId,
    inquiryId: draft.inquiryId,
    supplierId: draft.supplierId,
    status: draft.status,
    version: draft.version,
    payload,
    aiProvider: draft.aiProvider,
    aiModel: draft.aiModel,
    aiPromptVersion: draft.aiPromptVersion,
    aiConfidence: draft.aiConfidence,
    aiMetadata,
    confirmedAt: draft.confirmedAt?.toISOString() || null,
    confirmedById: draft.confirmedById,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    email: {
      id: draft.email.id,
      from: draft.email.from,
      fromName: draft.email.fromName,
      subject: draft.email.subject,
      receivedAt: draft.email.receivedAt.toISOString(),
      attachments: draft.email.attachmentRecords.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        contentId: attachment.contentId,
        storedObjectId: attachment.storedObjectId,
        downloadUrl: attachment.storedObject.status === 'AVAILABLE'
          ? '/api/files/' + encodeURIComponent(attachment.storedObjectId)
          : null,
      })),
    },
    inquiry: {
      id: draft.inquiry.id,
      inquiryNumber: draft.inquiry.inquiryNumber,
      supplierId: draft.inquiry.supplierId,
      items: draft.inquiry.items,
    },
    supplier: draft.supplier,
    supplierQuotes: draft.supplierQuotes,
  };
}

async function createDraft(args: {
  emailId: string;
  inquiryId: string;
  payload: DraftPayload;
  actorId: string;
  ai?: { model: string; promptVersion: number; agentId: string; itemCount: number } | null;
}) {
  const payload = withStableItemKeys(args.payload);
  try {
    return await prisma.$transaction(async (tx) => {
    const [email, inquiry, link] = await Promise.all([
      tx.email.findUnique({
        where: { id: args.emailId },
        select: { id: true, from: true, fromName: true, subject: true },
      }),
      tx.inquiry.findUnique({
        where: { id: args.inquiryId },
        select: {
          id: true,
          inquiryNumber: true,
          supplierId: true,
          supplier: { select: { email: true } },
        },
      }),
      tx.inquiryEmailLink.findUnique({
        where: { emailId_inquiryId: { emailId: args.emailId, inquiryId: args.inquiryId } },
        select: { confirmationStatus: true },
      }),
    ]);
    if (!email) throw new AppError('邮件不存在', 404, 'RESOURCE_NOT_FOUND');
    if (!inquiry) throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');
    if (!link || link.confirmationStatus !== 'CONFIRMED') {
      throw new AppError('请先人工确认邮件与询价单的关联', 409, 'STATE_CONFLICT');
    }

    const latestDraft = await tx.supplierQuoteDraft.findFirst({
      where: { emailId: email.id, inquiryId: inquiry.id },
      orderBy: { version: 'desc' },
      select: { version: true, status: true },
    });
    if (latestDraft?.status === 'DRAFT') {
      throw new AppError('该邮件与询价单已有未确认报价草稿，请继续编辑现有草稿', 409, 'STATE_CONFLICT');
    }
    const draft = await tx.supplierQuoteDraft.create({
      data: {
        emailId: email.id,
        inquiryId: inquiry.id,
        supplierId: inquiry.supplierId,
        status: 'DRAFT',
        version: (latestDraft?.version ?? 0) + 1,
        payloadJson: JSON.stringify(payload),
        aiModel: args.ai?.model ?? null,
        aiPromptVersion: args.ai ? String(args.ai.promptVersion) : null,
        aiMetadataJson: args.ai ? JSON.stringify({
          agentId: args.ai.agentId,
          candidateCount: args.ai.itemCount,
          createdById: args.actorId,
        }) : null,
      },
      include: supplierQuoteDraftInclude,
    });
    return draft;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
      throw new AppError('同一邮件与询价单的草稿版本已被并发创建，请重新加载后重试', 409, 'STATE_CONFLICT');
    }
    throw error;
  }
}

function confirmedPayload(payloadJson: string) {
  let value: unknown;
  try { value = JSON.parse(payloadJson); } catch {
    throw new AppError('报价草稿内容无法读取，请重新编辑后再确认', 409, 'STATE_CONFLICT');
  }
  const parsed = supplierQuoteDraftConfirmPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('报价草稿仍有缺项或交期范围未归一，请补全询价项、件号、数量、USD 单价和单一交期后再确认', 409, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

function isRetryableTransactionConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code);
}

router.post(
  '/extract',
  requireCapability('agent', 'run'),
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'create'),
  validateBody(supplierQuoteDraftExtractSchema),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const { emailId, inquiryId } = req.body;
    const [email, inquiry, link] = await Promise.all([
      prisma.email.findUnique({
        where: { id: emailId },
        select: { id: true, subject: true, body: true },
      }),
      prisma.inquiry.findUnique({
        where: { id: inquiryId },
        select: {
          id: true,
          inquiryNumber: true,
          supplierId: true,
          items: { orderBy: { lineNo: 'asc' }, select: { id: true, partNumber: true, quantity: true } },
        },
      }),
      prisma.inquiryEmailLink.findUnique({
        where: { emailId_inquiryId: { emailId, inquiryId } },
        select: { confirmationStatus: true },
      }),
    ]);
    if (!email) throw new AppError('邮件不存在', 404, 'RESOURCE_NOT_FOUND');
    if (!inquiry) throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');
    if (!link || link.confirmationStatus !== 'CONFIRMED') {
      throw new AppError('请先人工确认邮件与询价单的关联', 409, 'STATE_CONFLICT');
    }

    const extracted = await extractSupplierQuoteEmail(
      email.subject,
      email.body,
      {
        inquiryId: inquiry.id,
        inquiryNumber: inquiry.inquiryNumber,
        items: inquiry.items.map((item) => ({
          inquiryItemId: item.id,
          partNumber: item.partNumber,
          quantity: item.quantity,
        })),
      },
      { actorId: req.user!.id, action: 'business.extract-supplier-quote-email' },
    );
    const payload = supplierQuoteDraftPayloadSchema.parse({
      items: extracted.items.map((item) => {
        const extractedPartNumber = item.partNumber?.trim().toUpperCase() ?? null;
        const exactMatches = extractedPartNumber
          ? inquiry.items.filter((inquiryItem) => inquiryItem.partNumber.trim().toUpperCase() === extractedPartNumber)
          : [];
        return {
          itemKey: randomUUID(),
          inquiryItemId: exactMatches.length === 1 ? exactMatches[0].id : null,
          partNumber: exactMatches.length === 1 ? exactMatches[0].partNumber : item.partNumber ?? null,
          quantityUnit: item.quantityUnit ?? null,
          quantity: item.quantity ?? null,
          unitPrice: item.unitPrice ?? null,
          currency: item.currency ?? null,
          leadTimeDays: item.leadTimeDays ?? null,
          leadTimeMinDays: item.leadTimeMinDays ?? null,
          leadTimeMaxDays: item.leadTimeMaxDays ?? null,
          validUntil: item.validUntil ?? null,
          condition: item.condition ?? null,
          certificate: item.certificate ?? null,
          taxIncluded: item.taxIncluded ?? null,
          freightIncluded: item.freightIncluded ?? null,
          incoterm: item.incoterm ?? null,
          evidenceText: item.evidenceText,
        };
      }),
    });
    const draft = await createDraft({
      emailId,
      inquiryId,
      payload,
      actorId: req.user!.id,
      ai: {
        model: extracted.ai.model,
        promptVersion: extracted.ai.promptVersion,
        agentId: extracted.ai.agentId,
        itemCount: extracted.items.length,
      },
    });
    res.status(201).json({ success: true, data: serializeSupplierQuoteDraft(draft) });
  }),
);

router.post(
  '/',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'create'),
  validateBody(supplierQuoteDraftCreateSchema),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const draft = await createDraft({
      ...req.body,
      actorId: req.user!.id,
    });
    res.status(201).json({ success: true, data: serializeSupplierQuoteDraft(draft) });
  }),
);

router.get(
  '/',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const emailId = typeof req.query.emailId === 'string' ? req.query.emailId.trim() : '';
    const inquiryId = typeof req.query.inquiryId === 'string' ? req.query.inquiryId.trim() : '';
    if (!emailId || !inquiryId) {
      throw new AppError('emailId 和 inquiryId 必须是非空字符串', 400, 'BAD_REQUEST');
    }
    const draft = await prisma.supplierQuoteDraft.findFirst({
      where: { emailId, inquiryId },
      orderBy: { version: 'desc' },
      include: supplierQuoteDraftInclude,
    });
    res.json({ success: true, data: draft ? serializeSupplierQuoteDraft(draft) : null });
  }),
);

router.get(
  '/:id',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const draft = await prisma.supplierQuoteDraft.findUnique({
      where: { id: req.params.id },
      include: supplierQuoteDraftInclude,
    });
    if (!draft) throw new AppError('供应商报价草稿不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data: serializeSupplierQuoteDraft(draft) });
  }),
);

router.patch(
  '/:id',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'update'),
  validateBody(supplierQuoteDraftPatchSchema),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const payload = withStableItemKeys(req.body.payload);
    let updated: SupplierQuoteDraftRecord;
    try {
      updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.supplierQuoteDraft.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, version: true },
      });
      if (!existing) throw new AppError('供应商报价草稿不存在', 404, 'RESOURCE_NOT_FOUND');
      if (existing.status !== 'DRAFT') throw new AppError('已确认的报价草稿不能修改', 409, 'STATE_CONFLICT');
      if (existing.version !== req.body.expectedVersion) {
        throw new AppError('报价草稿已被其他用户修改，请重新加载', 409, 'STATE_CONFLICT');
      }
      const result = await tx.supplierQuoteDraft.updateMany({
        where: { id: existing.id, status: 'DRAFT', version: req.body.expectedVersion },
        data: { payloadJson: JSON.stringify(payload), version: { increment: 1 } },
      });
      if (result.count !== 1) throw new AppError('报价草稿已被其他用户修改，请重新加载', 409, 'STATE_CONFLICT');
      return tx.supplierQuoteDraft.findUniqueOrThrow({
        where: { id: existing.id },
        include: supplierQuoteDraftInclude,
      });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionConflict(error)) {
        throw new AppError('报价草稿已被其他用户修改，请重新加载', 409, 'STATE_CONFLICT');
      }
      throw error;
    }
    res.json({ success: true, data: serializeSupplierQuoteDraft(updated) });
  }),
);

router.post(
  '/:id/confirm',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'create'),
  requireCapability('supplier_quote', 'update'),
  validateBody(supplierQuoteDraftConfirmSchema),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const { expectedVersion } = req.body;
    const actorId = req.user!.id;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const draft = await tx.supplierQuoteDraft.findUnique({
          where: { id: req.params.id },
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
        if (draft.version !== expectedVersion) {
          throw new AppError('报价草稿版本已变化，请重新加载后确认', 409, 'STATE_CONFLICT');
        }
        if (draft.status === 'CONFIRMED') {
          const quotes = await tx.supplierQuote.findMany({
            where: { sourceDraftId: draft.id },
            orderBy: { sourceDraftItemKey: 'asc' },
          });
          if (quotes.length === 0) throw new AppError('已确认草稿缺少报价记录，请联系管理员', 409, 'STATE_CONFLICT');
          return { draft, quotes, reused: true };
        }
        if (draft.status !== 'DRAFT') throw new AppError('当前报价草稿状态不能确认', 409, 'STATE_CONFLICT');

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

        const payload = confirmedPayload(draft.payloadJson);
        const itemIds = [...new Set(payload.items.map((item) => item.inquiryItemId))];
        const inquiryItems = await tx.inquiryItem.findMany({
          where: { inquiryId: inquiry.id, id: { in: itemIds } },
          select: { id: true, inquiryId: true, partNumber: true, quantity: true },
        });
        const inquiryItemsById = new Map(inquiryItems.map((item) => [item.id, item]));
        if (inquiryItemsById.size !== itemIds.length) {
          throw new AppError('报价草稿包含不属于当前询价单的需求项', 409, 'RESOURCE_CONFLICT');
        }
        for (const item of payload.items) {
          const inquiryItem = inquiryItemsById.get(item.inquiryItemId);
          if (!inquiryItem || inquiryItem.partNumber !== item.partNumber) {
            throw new AppError('报价件号必须与选定的询价需求项完全一致', 409, 'RESOURCE_CONFLICT');
          }
          if (item.quantity > inquiryItem.quantity) {
            throw new AppError('报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
          }
        }

        const confirmedAt = new Date();
        const claimed = await tx.supplierQuoteDraft.updateMany({
          where: { id: draft.id, status: 'DRAFT', version: expectedVersion },
          data: { status: 'CONFIRMED', confirmedAt, confirmedById: actorId },
        });
        if (claimed.count !== 1) {
          throw new AppError('报价草稿已被其他用户确认或修改', 409, 'STATE_CONFLICT');
        }

        for (const item of payload.items) {
          const source = await resolveSupplierQuoteSourceBinding(tx, {
            rfqId: inquiry.rfqId,
            inquiryId: inquiry.id,
            inquiryItemId: item.inquiryItemId,
            supplierId: draft.supplierId,
            partNumber: item.partNumber,
            quantity: item.quantity,
          });
          const unitPriceDecimal = normalizeMoney(item.unitPrice);
          const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, item.quantity);
          await tx.supplierQuote.create({
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
        }
        const quotes = await tx.supplierQuote.findMany({
          where: { sourceDraftId: draft.id },
          orderBy: { sourceDraftItemKey: 'asc' },
        });
        return { draft, quotes, reused: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      res.json({
        success: true,
        data: {
          draftId: result.draft.id,
          status: 'CONFIRMED',
          version: result.draft.version,
          reused: result.reused,
          supplierQuoteIds: result.quotes.map((quote) => quote.id),
          createdSupplierQuoteIds: result.reused ? [] : result.quotes.map((quote) => quote.id),
          reusedSupplierQuoteIds: result.reused ? result.quotes.map((quote) => quote.id) : [],
          supplierQuotes: result.quotes,
        },
      });
    } catch (error) {
      if (!isRetryableTransactionConflict(error)) throw error;
      const draft = await prisma.supplierQuoteDraft.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, version: true },
      });
      if (!draft || draft.status !== 'CONFIRMED' || draft.version !== expectedVersion) throw error;
      const quotes = await prisma.supplierQuote.findMany({
        where: { sourceDraftId: draft.id },
        orderBy: { sourceDraftItemKey: 'asc' },
      });
      if (!quotes.length) throw error;
      res.json({
        success: true,
        data: {
          draftId: draft.id,
          status: 'CONFIRMED',
          version: draft.version,
          reused: true,
          supplierQuoteIds: quotes.map((quote) => quote.id),
          createdSupplierQuoteIds: [],
          reusedSupplierQuoteIds: quotes.map((quote) => quote.id),
          supplierQuotes: quotes,
        },
      });
    }
  }),
);

export default router;
