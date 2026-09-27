import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../middleware/auth.js';
import { assertCapability } from '../middleware/capability.js';
import { AppError } from '../middleware/errorHandler.js';
import { inquiryReadScope } from './inquirySendCommand.js';

export const SEND_INQUIRY_ACTION = 'SEND_INQUIRY';
export const SOURCING_ACTION_TASK_MAX_ATTEMPTS = 3;

export type InquirySendContentSnapshot = {
  subject: string;
  textBody: string;
};

type ActionActor = NonNullable<AuthRequest['user']>;

/** Capture the exact Inquiry facts against which a human-confirmed send is staged. */
export async function captureInquirySendTargetVersion(
  tx: Prisma.TransactionClient,
  actor: ActionActor,
  inquiryId: string,
  permission: 'create' | 'read' = 'create',
) {
  assertCapability(actor, 'supplier_quote', permission);
  const inquiry = await tx.inquiry.findFirst({
    where: { id: inquiryId, ...inquiryReadScope(actor) },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      items: { orderBy: [{ lineNo: 'asc' }, { id: 'asc' }] },
      rfq: {
        include: {
          creator: { select: { department: true } },
          lines: { select: { id: true, status: true }, orderBy: { id: 'asc' } },
        },
      },
    },
  });
  if (!inquiry) throw new AppError('询价单不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
  if (inquiry.rfq) {
    assertCapability(actor, 'rfq', 'read', {
      ownerId: inquiry.rfq.createdBy,
      department: inquiry.rfq.creator.department,
    });
  }

  const source = {
    id: inquiry.id,
    inquiryNumber: inquiry.inquiryNumber,
    supplierId: inquiry.supplierId,
    supplier: {
      id: inquiry.supplier.id,
      name: inquiry.supplier.name,
      email: inquiry.supplier.email?.trim() ?? null,
    },
    rfqId: inquiry.rfqId,
    rfq: inquiry.rfq ? {
      id: inquiry.rfq.id,
      rfqNumber: inquiry.rfq.rfqNumber,
      createdBy: inquiry.rfq.createdBy,
      status: inquiry.rfq.status,
      creatorDepartment: inquiry.rfq.creator.department,
      lines: inquiry.rfq.lines.map((line) => ({ id: line.id, status: line.status })),
    } : null,
    notes: inquiry.notes,
    isAOG: inquiry.isAOG,
    status: inquiry.status,
    items: inquiry.items.map((item) => ({
      id: item.id,
      lineNo: item.lineNo,
      rfqLineId: item.rfqLineId,
      partNumber: item.partNumber,
      quantity: item.quantity,
      requiredDate: item.requiredDate.toISOString(),
      certificateRequired: item.certificateRequired,
    })),
  };
  const targetVersion = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  return { inquiry, targetVersion };
}

export function assertInquirySendTargetOpen(inquiry: Awaited<ReturnType<typeof captureInquirySendTargetVersion>>['inquiry']) {
  if (inquiry.rfq && ['CANCELLED', 'COMPLETED'].includes(inquiry.rfq.status)) {
    throw new AppError('需求已关闭，不能发送此询价', 409, 'STATE_CONFLICT');
  }
  const rfqLines = new Map((inquiry.rfq?.lines ?? []).map((line) => [line.id, line]));
  if (inquiry.items.some((item) => {
    if (!item.rfqLineId) return false;
    const line = rfqLines.get(item.rfqLineId);
    return !line || line.status !== 'OPEN';
  })) {
    throw new AppError('询价关联的需求行已关闭或不属于当前需求', 409, 'STATE_CONFLICT');
  }
}

export function parseInquirySendContentSnapshot(value: string): InquirySendContentSnapshot {
  try {
    const parsed = JSON.parse(value) as Partial<InquirySendContentSnapshot> | null;
    if (parsed && typeof parsed.subject === 'string' && typeof parsed.textBody === 'string') {
      return { subject: parsed.subject, textBody: parsed.textBody };
    }
  } catch {
    // Fall through to the same safe state error as an unsupported legacy snapshot.
  }
  throw new AppError('任务中的询价邮件版本不可用，请重新创建任务', 409, 'STATE_CONFLICT');
}
