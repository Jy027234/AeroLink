import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import {
  supplierQuoteDraftConfirmSchema,
  supplierQuoteDraftCreateSchema,
  supplierQuoteDraftExtractSchema,
  supplierQuoteDraftPatchSchema,
  supplierQuoteDraftPayloadSchema,
} from '../lib/validation.js';
import { extractSupplierQuoteEmail } from '../lib/aiService.js';
import { createOriginalAiCandidateSnapshot } from '../lib/sourcingAiCandidateSnapshot.js';
import {
  assertDraftSourceAccess,
  assertRfqReadAccess,
  confirmSupplierQuoteDraftCommand,
} from '../lib/supplierQuoteDraftConfirmCommand.js';
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
      quantityUnit: true,
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
  actor: NonNullable<AuthRequest['user']>;
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
          rfqId: true,
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
    await assertRfqReadAccess(args.actor, inquiry.rfqId, tx);
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
          createdById: args.actor.id,
          originalAiCandidates: createOriginalAiCandidateSnapshot(payload.items),
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
    await assertDraftSourceAccess(req.user!, emailId, inquiryId, prisma);
    const [email, inquiry] = await Promise.all([
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
    ]);
    if (!email) throw new AppError('邮件不存在', 404, 'RESOURCE_NOT_FOUND');
    if (!inquiry) throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');

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
      actor: req.user!,
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
      actor: req.user!,
    });
    res.status(201).json({ success: true, data: serializeSupplierQuoteDraft(draft) });
  }),
);

router.get(
  '/',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const emailId = typeof req.query.emailId === 'string' ? req.query.emailId.trim() : '';
    const inquiryId = typeof req.query.inquiryId === 'string' ? req.query.inquiryId.trim() : '';
    if (!emailId || !inquiryId) {
      throw new AppError('emailId 和 inquiryId 必须是非空字符串', 400, 'BAD_REQUEST');
    }
    await assertDraftSourceAccess(actor, emailId, inquiryId, prisma);
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
    const actor = (req as AuthRequest).user!;
    const draftRef = await prisma.supplierQuoteDraft.findUnique({
      where: { id: req.params.id },
      select: { emailId: true, inquiryId: true },
    });
    if (!draftRef) throw new AppError('供应商报价草稿不存在', 404, 'RESOURCE_NOT_FOUND');
    await assertDraftSourceAccess(actor, draftRef.emailId, draftRef.inquiryId, prisma);
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
        select: { id: true, emailId: true, inquiryId: true, status: true, version: true },
      });
      if (!existing) throw new AppError('供应商报价草稿不存在', 404, 'RESOURCE_NOT_FOUND');
      await assertDraftSourceAccess(req.user!, existing.emailId, existing.inquiryId, tx);
      if (existing.status !== 'DRAFT') throw new AppError('已确认的报价草稿不能修改', 409, 'STATE_CONFLICT');
      if (existing.version !== req.body.expectedVersion) {
        throw new AppError('报价草稿已被其他用户修改，请重新加载', 409, 'STATE_CONFLICT');
      }
      const result = await tx.supplierQuoteDraft.updateMany({
        where: { id: existing.id, status: 'DRAFT', version: req.body.expectedVersion },
        data: { payloadJson: JSON.stringify(payload), version: { increment: 1 } },
      });
      if (result.count !== 1) throw new AppError('报价草稿已被其他用户修改，请重新加载', 409, 'STATE_CONFLICT');
      await tx.auditLog.create({
        data: {
          userId: req.user!.id,
          userName: req.user!.name || null,
          userRole: req.user!.role,
          action: 'UPDATE',
          resourceType: 'SUPPLIER_QUOTE_DRAFT',
          resourceId: existing.id,
          changes: JSON.stringify({ version: { before: existing.version, after: existing.version + 1 } }),
          details: 'Human-reviewed supplier quote draft saved',
        },
      });
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
    const data = await confirmSupplierQuoteDraftCommand(req.user!, req.params.id, expectedVersion);
    res.json({ success: true, data });
  }),
);

export default router;
