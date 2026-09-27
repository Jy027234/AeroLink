import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthRequest } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertCapability } from '../middleware/capability.js';
import { buildRfqReadScope } from './rfqAccess.js';
import { getCapabilityScope } from './capabilityPolicy.js';
import { enqueueOutboundEmail } from './outboxService.js';

type InquirySendActor = NonNullable<AuthRequest['user']>;

export type InquirySendContent = {
  subject?: string;
  textBody?: string;
};

export function inquiryReadScope(actor: InquirySendActor): Prisma.InquiryWhereInput {
  const linked = { rfq: { is: buildRfqReadScope(actor) } } satisfies Prisma.InquiryWhereInput;
  // Unknown historical ownership is never inferred from a matching part number.
  return getCapabilityScope(actor, 'rfq.read') === 'all' ? { OR: [linked, { rfqId: null }] } : linked;
}

function defaultInquirySubject(inquiry: { inquiryNumber: string; isAOG: boolean; rfq?: { rfqNumber: string } | null }) {
  const markers = [inquiry.isAOG ? 'AOG' : null, inquiry.rfq?.rfqNumber].filter(Boolean).join(' · ');
  return `航材询价 ${inquiry.inquiryNumber}${markers ? ` - ${markers}` : ''}`;
}

function defaultInquiryText(inquiry: {
  inquiryNumber: string;
  isAOG: boolean;
  rfq?: { rfqNumber: string } | null;
  items: Array<{ lineNo: number; partNumber: string; quantity: number; requiredDate: Date; certificateRequired: boolean }>;
}) {
  const lines = [
    '尊敬的供应商：',
    '',
    '请贵司就以下航材需求提供报价。',
    `询价单号：${inquiry.inquiryNumber}`,
    ...(inquiry.rfq?.rfqNumber ? [`需求单号：${inquiry.rfq.rfqNumber}`] : []),
    `紧急程度：${inquiry.isAOG ? 'AOG（停场紧急）' : '标准'}`,
    '',
    '需求明细：',
    ...inquiry.items.map(item => `${item.lineNo}. 件号 ${item.partNumber}；数量 ${item.quantity}；需求日期 ${item.requiredDate.toISOString().slice(0, 10)}；要求适航证书 ${item.certificateRequired ? '是' : '否'}`),
    '',
    '请回复单价及币种、航材状态、交期、证书情况和报价有效期。',
    '',
    '谢谢。',
  ];
  return lines.join('\n');
}

/**
 * Queue an inquiry email using the caller's transaction. Callers own the
 * idempotency boundary and serialize the returned snapshot before commit.
 */
export async function sendInquiryCommand(
  tx: Prisma.TransactionClient,
  actor: InquirySendActor,
  inquiryId: string,
  content: InquirySendContent,
) {
  assertCapability(actor, 'supplier_quote', 'create');

  const inquiry = await tx.inquiry.findFirst({
    where: { id: inquiryId, ...inquiryReadScope(actor) },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      items: { orderBy: { lineNo: 'asc' } },
      rfq: { include: { creator: { select: { department: true } } } },
    },
  });

  if (!inquiry) throw new AppError('询价单不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
  if (inquiry.status !== 'DRAFT') {
    throw new AppError(`询价状态为 ${inquiry.status}，只有草稿可以发送`, 409, 'STATE_CONFLICT');
  }
  if (inquiry.rfq) {
    assertCapability(actor, 'rfq', 'read', {
      ownerId: inquiry.rfq.createdBy,
      department: inquiry.rfq.creator.department,
    });
    if (inquiry.rfq.status === 'CANCELLED' || inquiry.rfq.status === 'COMPLETED') {
      throw new AppError('需求已关闭，不能发送询价', 409, 'INVALID_STATE_TRANSITION');
    }
  }
  if (!inquiry.items.length) throw new AppError('询价没有需求明细，无法发送', 409, 'STATE_CONFLICT');
  const selectedLineIds = [...new Set(inquiry.items.map((item) => item.rfqLineId).filter((id): id is string => Boolean(id)))];
  if (selectedLineIds.length > 0) {
    const lines = await tx.rfqLine.findMany({
      where: { id: { in: selectedLineIds } },
      select: { id: true, rfqId: true, status: true },
    });
    const selectedLineById = new Map(lines.map((line) => [line.id, line]));
    if (selectedLineIds.some((id) => {
      const line = selectedLineById.get(id);
      return !line || !inquiry.rfqId || line.rfqId !== inquiry.rfqId || line.status !== 'OPEN';
    })) {
      throw new AppError('询价包含已关闭或不属于该需求的需求行，不能发送', 409, 'INVALID_STATE_TRANSITION');
    }
  }

  const recipient = inquiry.supplier.email?.trim();
  if (!recipient || !z.string().email().safeParse(recipient).success) {
    throw new AppError('供应商没有有效的询价邮箱，无法发送', 409, 'RESOURCE_CONFLICT');
  }

  const account = await tx.emailAccount.findFirst({
    where: { isDefault: true, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!account) throw new AppError('没有已启用的默认邮箱账户，无法发送询价', 409, 'RESOURCE_CONFLICT');

  const emailSubject = content.subject ?? defaultInquirySubject(inquiry);
  const emailText = content.textBody ?? defaultInquiryText(inquiry);
  const outboundEmail = await tx.outboundEmail.create({
    data: {
      purpose: 'INQUIRY_SEND',
      inquiryId: inquiry.id,
      accountId: account.id,
      toEmail: recipient,
      subject: emailSubject,
      textBody: emailText,
      status: 'PENDING',
    },
    select: { id: true, status: true, errorMessage: true, sentAt: true },
  });
  const queuedInquiry = await tx.inquiry.update({
    where: { id: inquiry.id },
    data: { status: 'QUEUED' },
  });
  const outboxEvent = await enqueueOutboundEmail(tx, {
    eventType: 'inquiry.email.send',
    aggregateType: 'INQUIRY',
    aggregateId: inquiry.id,
    outboundEmailId: outboundEmail.id,
    createdById: actor.id,
  });
  await tx.auditLog.create({
    data: {
      userId: actor.id,
      userName: actor.name || null,
      userRole: actor.role,
      action: 'APPROVE',
      resourceType: 'OUTBOUND_EMAIL',
      resourceId: outboundEmail.id,
      details: 'Human confirmed inquiry email version for queued delivery',
    },
  });

  return { inquiry, queuedInquiry, outboundEmail, outboxEvent };
}
