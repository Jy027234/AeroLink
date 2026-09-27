import { Router } from 'express';
import { Prisma, type RfqLine } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { createAuditLog } from '../middleware/auditLogger.js';
import { validateBody } from '../middleware/validate.js';
import { rfqStatusUpdateSchema } from '../lib/validation.js';
import { AuthRequest } from '../middleware/auth.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { enqueueBusinessEvent } from '../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../lib/socketEvents.js';
import {
  assertRfqTransition,
  createRfqAggregate,
  normalizeRfqStatus,
  rfqCreateSchema,
  rfqRepository,
  rfqUpdateSchema,
  toUiRfqStatus,
  transitionRfqStatus,
  updateRfqAggregate,
} from '../modules/rfqSourcing/index.js';
import {
  preferredQuotationStatus,
  preferredRfqStatus,
  preferredSupplierQuoteStatus,
} from '../lib/transactionStatusShadows.js';
import { buildRfqReadScope } from '../lib/rfqAccess.js';
import { readOriginalAiCandidateSnapshot, type SourcingAiCandidateSnapshotItem } from '../lib/sourcingAiCandidateSnapshot.js';
import { parseControlledExportWindow, parseListQuery, sendCsv, type SortDirection } from '../lib/listQuery.js';
import prisma from '../lib/prisma.js';

const router = Router();

type ScopedRfq = {
  createdBy: string;
  creator?: { department?: string | null } | null;
};

type RfqListSort = 'createdAt' | 'requiredDate' | 'responseDeadline' | 'rfqNumber';

function rfqListOrderBy(sort: RfqListSort, direction: SortDirection): Prisma.RFQOrderByWithRelationInput[] {
  switch (sort) {
    case 'requiredDate':
      return [{ requiredDate: direction }, { id: 'asc' }];
    case 'responseDeadline':
      return [{ responseDeadline: direction }, { id: 'asc' }];
    case 'rfqNumber':
      return [{ rfqNumber: direction }, { id: 'asc' }];
    default:
      return [{ createdAt: direction }, { id: 'asc' }];
  }
}

function buildRfqListWhere(
  query: Record<string, unknown>,
  actor: NonNullable<AuthRequest['user']>,
): Prisma.RFQWhereInput {
  const status = typeof query.status === 'string' ? query.status : '';
  const urgency = typeof query.urgency === 'string' ? query.urgency : '';
  const search = typeof query.search === 'string' ? query.search : '';
  const filters: Prisma.RFQWhereInput[] = [buildRfqReadScope(actor)];
  if (status) {
    filters.push({ status: normalizeRfqStatus(status) || status.toUpperCase() });
  }
  if (urgency) filters.push({ urgency: urgency.toUpperCase() });
  const searchValue = search.trim();
  if (searchValue) {
    filters.push({
      OR: [
        { rfqNumber: { contains: searchValue, mode: 'insensitive' } },
        { partNumber: { contains: searchValue, mode: 'insensitive' } },
        { lines: { some: { partNumber: { contains: searchValue, mode: 'insensitive' }, status: { not: 'CANCELLED' } } } },
        { customer: { is: { name: { contains: searchValue, mode: 'insensitive' } } } },
      ],
    });
  }
  return filters.length === 1 ? filters[0] : { AND: filters };
}

function assertRfqAccess(
  actor: NonNullable<AuthRequest['user']>,
  action: 'read' | 'update' | 'transition',
  rfq: ScopedRfq,
) {
  assertCapability(actor, 'rfq', action, {
    ownerId: rfq.createdBy,
    department: rfq.creator?.department,
  });
}

function parseAlternatePartNumbers(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

const MAX_RFQ_SOURCING_LINES = 100;
const MAX_RFQ_SOURCING_EVIDENCE_PER_SOURCE = 250;
const MAX_RFQ_SOURCING_CATEGORY_PROFILES = 250;
const MAX_RFQ_SOURCING_CANDIDATES_PER_LINE = 30;

function normalizeSourcingToken(value: string | null | undefined): string {
  return value?.trim().toLocaleUpperCase() ?? '';
}

type SourcingCountInquiry = {
  id: string;
  status: string;
  sentAt: Date | null;
  items: Array<{ id: string; rfqLineId: string | null; partNumber: string }>;
  outboundEmails: Array<{ status: string; sentAt: Date | null }>;
  quoteDrafts: Array<{ status: string; payloadJson: string }>;
};

type SourcingCountQuote = {
  rfqId: string | null;
  inquiryId: string | null;
  inquiryItemId: string | null;
  rfqLineId: string | null;
  partNumber: string;
  supersededAt?: Date | null;
};

/**
 * Derive the SQ-08 waiting counts only from persisted, explicit foreign-key bindings.
 * A sent InquiryItem is pending a formal quote only after SMTP acceptance (or the
 * legacy Inquiry.sentAt/status=SENT fact), and only when no exact draft/quote item
 * covers it. DRAFT payload rows count as pending confirmation only when their
 * inquiryItemId points back into that same Inquiry and the item has an active line
 * in this RFQ. A stored inquiryItemId or unique inquiry+line pair is authoritative
 * even when the supplier quoted an explicitly linked alternate PN; partNumber is
 * never used to infer ownership.
 *
 * Rows without a trustworthy active line, ambiguous/conflicting quote links, and
 * unbindable draft rows are retained in unassignedNeedsVerification. Unsent or
 * delivery-uncertain inquiries are excluded from pendingQuoteCount; partial formal
 * quotes count as quoted items here, while quantity sufficiency remains exclusively
 * the comparison summary's concern.
 */
function deriveSourcingCounts(
  rfqId: string,
  lines: Array<{ id: string; status: string }>,
  inquiries: SourcingCountInquiry[],
  quotes: SourcingCountQuote[],
) {
  const activeLineIds = new Set(lines
    .filter((line) => normalizeSourcingToken(line.status) !== 'CANCELLED')
    .map((line) => line.id));
  const lineCounts = new Map([...activeLineIds].map((rfqLineId) => [rfqLineId, {
    rfqLineId,
    pendingQuoteCount: 0,
    pendingConfirmationCount: 0,
  }]));
  const unassignedNeedsVerification = {
    pendingQuoteCount: 0,
    pendingConfirmationCount: 0,
    supplierQuoteCount: 0,
    unreadableDraftCount: 0,
  };

  const itemById = new Map<string, { inquiryId: string; rfqLineId: string | null; partNumber: string }>();
  const itemsByInquiryId = new Map<string, Array<{ id: string; rfqLineId: string | null; partNumber: string }>>();
  for (const inquiry of inquiries) {
    itemsByInquiryId.set(inquiry.id, inquiry.items);
    for (const item of inquiry.items) itemById.set(item.id, { inquiryId: inquiry.id, ...item });
  }

  const quotedItemIds = new Set<string>();
  const quoteNeedsVerificationItemIds = new Set<string>();
  const markQuoteCandidatesForVerification = (quote: SourcingCountQuote) => {
    if (!quote.inquiryId) return;
    const inquiryItems = itemsByInquiryId.get(quote.inquiryId) ?? [];
    const candidates = quote.rfqLineId
      ? inquiryItems.filter((item) => item.rfqLineId === quote.rfqLineId)
      : inquiryItems;
    for (const item of candidates) quoteNeedsVerificationItemIds.add(item.id);
  };
  for (const quote of quotes) {
    // Only the current revision is an active formal quote. Older revisions stay
    // in the timeline as history, but must not satisfy (or poison) current counts.
    if (quote.supersededAt) continue;
    const quoteIsBoundToAnotherRfq = Boolean(quote.rfqId && quote.rfqId !== rfqId);
    const directlyBoundItem = quote.inquiryItemId ? itemById.get(quote.inquiryItemId) : undefined;
    if (quote.inquiryItemId) {
      const bindingIsConsistent = directlyBoundItem
        && !quoteIsBoundToAnotherRfq
        && (!quote.inquiryId || quote.inquiryId === directlyBoundItem.inquiryId)
        && (!quote.rfqLineId || quote.rfqLineId === directlyBoundItem.rfqLineId);
      if (bindingIsConsistent) {
        quotedItemIds.add(quote.inquiryItemId);
        if (!directlyBoundItem!.rfqLineId || !activeLineIds.has(directlyBoundItem!.rfqLineId)) {
          unassignedNeedsVerification.supplierQuoteCount += 1;
        }
      } else {
        unassignedNeedsVerification.supplierQuoteCount += 1;
        if (directlyBoundItem) quoteNeedsVerificationItemIds.add(quote.inquiryItemId);
        else markQuoteCandidatesForVerification(quote);
      }
      continue;
    }

    // Older formal quotes can be tied safely by inquiry + explicit RFQ line only
    // when that pair identifies exactly one inquiry item. A part-number match is
    // never used to choose between duplicate items.
    const candidates = quote.inquiryId && quote.rfqLineId
      ? (itemsByInquiryId.get(quote.inquiryId) ?? []).filter((item) => item.rfqLineId === quote.rfqLineId)
      : [];
    const uniqueCandidate = candidates.length === 1 ? candidates[0] : null;
    if (uniqueCandidate && !quoteIsBoundToAnotherRfq) {
      quotedItemIds.add(uniqueCandidate.id);
      if (!uniqueCandidate.rfqLineId || !activeLineIds.has(uniqueCandidate.rfqLineId)) {
        unassignedNeedsVerification.supplierQuoteCount += 1;
      }
      continue;
    }

    unassignedNeedsVerification.supplierQuoteCount += 1;
    markQuoteCandidatesForVerification(quote);
  }

  const draftBoundItemIds = new Set<string>();
  for (const inquiry of inquiries) {
    for (const draft of inquiry.quoteDrafts) {
      if (normalizeSourcingToken(draft.status) !== 'DRAFT') continue;
      let payload: unknown;
      try {
        payload = JSON.parse(draft.payloadJson);
      } catch {
        unassignedNeedsVerification.unreadableDraftCount += 1;
        continue;
      }
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { items?: unknown }).items)) {
        unassignedNeedsVerification.unreadableDraftCount += 1;
        continue;
      }
      for (const rawItem of (payload as { items: unknown[] }).items) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          unassignedNeedsVerification.pendingConfirmationCount += 1;
          continue;
        }
        const itemPayload = rawItem as Record<string, unknown>;
        const inquiryItemId = typeof itemPayload.inquiryItemId === 'string' ? itemPayload.inquiryItemId : '';
        const inquiryItem = inquiryItemId ? itemById.get(inquiryItemId) : undefined;
        const explicitLineIds = ['rfqLineId', 'lineId']
          .filter((key) => key in itemPayload && itemPayload[key] != null)
          .map((key) => itemPayload[key]);
        const explicitLineIsConsistent = explicitLineIds.every((lineId) =>
          typeof lineId === 'string' && lineId === inquiryItem?.rfqLineId);
        if (!inquiryItem
          || inquiryItem.inquiryId !== inquiry.id
          || !explicitLineIsConsistent
          || !inquiryItem.rfqLineId
          || !activeLineIds.has(inquiryItem.rfqLineId)) {
          unassignedNeedsVerification.pendingConfirmationCount += 1;
          continue;
        }
        const lineCount = lineCounts.get(inquiryItem.rfqLineId);
        if (!lineCount) {
          unassignedNeedsVerification.pendingConfirmationCount += 1;
          continue;
        }
        lineCount.pendingConfirmationCount += 1;
        draftBoundItemIds.add(inquiryItemId);
      }
    }
  }

  for (const inquiry of inquiries) {
    const hasAcceptedOutbound = inquiry.outboundEmails.some((outbound) => {
      const status = normalizeSourcingToken(outbound.status);
      return status === 'SENT' || status === 'SMTP_ACCEPTED';
    });
    const isLegacySent = inquiry.outboundEmails.length === 0
      && (normalizeSourcingToken(inquiry.status) === 'SENT' || inquiry.sentAt !== null);
    if (!hasAcceptedOutbound && !isLegacySent) continue;
    for (const item of inquiry.items) {
      if (quotedItemIds.has(item.id) || draftBoundItemIds.has(item.id)) continue;
      if (quoteNeedsVerificationItemIds.has(item.id) || !item.rfqLineId || !activeLineIds.has(item.rfqLineId)) {
        unassignedNeedsVerification.pendingQuoteCount += 1;
        continue;
      }
      const lineCount = lineCounts.get(item.rfqLineId);
      if (lineCount) lineCount.pendingQuoteCount += 1;
      else unassignedNeedsVerification.pendingQuoteCount += 1;
    }
  }

  return {
    lines: [...lineCounts.values()],
    unassignedNeedsVerification,
  };
}

type SourcingWorkflowStatus =
  | 'WAITING_REPLY' | 'WAITING_HUMAN' | 'PROCESSING' | 'FAILED'
  | 'CANCELLED' | 'NEEDS_VERIFICATION' | 'COMPLETED';
type SourcingWorkflowAction =
  | 'VERIFY_DELIVERY' | 'VERIFY_REPLY_LINK' | 'VERIFY_RECORD' | 'REVIEW_DRAFT_BINDING'
  | 'REVIEW_QUOTE_DRAFT' | 'CREATE_MANUAL_DRAFT' | 'WAIT_FOR_PROCESSING'
  | 'FOLLOW_UP_SUPPLIER' | 'REVIEW_MISSING_ITEMS' | 'REVIEW_COMPARISON'
  | 'REVIEW_BEFORE_RESEND' | 'STOP_CANCELLED_RFQ' | 'SEND_INQUIRY' | 'NO_ACTION';
type SourcingWorkflowInquiry = {
  id: string;
  status: string;
  sentAt: Date | null;
  items: Array<{ id: string; rfqLineId: string | null; partNumber: string }>;
  outboundEmails: Array<{ id: string; purpose: string; status: string; createdAt: Date; sentAt: Date | null; withdrawnAt: Date | null }>;
  emailLinks: Array<{
    confirmationStatus: string;
    confirmedAt: Date | null;
    email: { id: string; receivedAt: Date };
  }>;
  quoteDrafts: Array<{ id: string; emailId: string; status: string; payloadJson: string; createdAt: Date; confirmedAt: Date | null }>;
  sourcingAiTasks: Array<{ id: string; emailId: string; type: string; status: string; draftId: string | null; createdAt: Date; updatedAt: Date }>;
};
type SourcingWorkflowActionTask = {
  id: string;
  action: string;
  status: string;
  targetInquiryId: string | null;
  targetSupplierQuoteId: string | null;
  outboundEmailId: string | null;
  resultJson: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type SourcingWorkflowQuote = {
  id: string;
  rfqId: string | null;
  rfqLineId: string | null;
  inquiryId: string | null;
  inquiryItemId: string | null;
  sourceDraftId: string | null;
  partNumber: string;
  supersededAt: Date | null;
  createdAt: Date;
};

type SourcingInquiryWorkflowState = {
  inquiryId: string;
  status: SourcingWorkflowStatus;
  nextAction: SourcingWorkflowAction;
};

function parseSendActionResult(resultJson: string | null): { inquiryId?: unknown; outboundEmailId?: unknown } | null {
  if (!resultJson) return null;
  try {
    const parsed: unknown = JSON.parse(resultJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { inquiryId?: unknown; outboundEmailId?: unknown }
      : null;
  } catch {
    return null;
  }
}

/**
 * Derive one recoverable SQ-07 workflow view per persisted Inquiry. The projection
 * is not a second task store: every state is rebuilt from RFQ, inquiry send/reply,
 * AI-task, draft and current formal-quote records on each timeline read. It never
 * treats a queued send as accepted, SMTP acceptance as supplier receipt/read, or
 * a draft as a formal quote. A newer accepted send invalidates older reply/draft/
 * quote coverage unless its explicit persisted timestamps prove newer artifacts.
 */
function deriveInquiryWorkflowStates(
  rfq: { id: string; status: string },
  inquiries: SourcingWorkflowInquiry[],
  quotes: SourcingWorkflowQuote[],
  actionTasks: SourcingWorkflowActionTask[],
) {
  const rfqWasCancelled = normalizeSourcingToken(rfq.status) === 'CANCELLED';
  return inquiries.map((inquiry) => {
    const action = (status: SourcingWorkflowStatus, nextAction: SourcingWorkflowAction) => ({
      inquiryId: inquiry.id,
      status,
      nextAction,
    });
    const inquiryStatus = normalizeSourcingToken(inquiry.status);
    const inquiryItemsById = new Map(inquiry.items.map((item) => [item.id, item]));
    const inquiryEmails = inquiry.outboundEmails
      .filter((email) => normalizeSourcingToken(email.purpose) === 'INQUIRY_SEND')
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const latestEmail = inquiryEmails[inquiryEmails.length - 1] ?? null;
    const sendActionTasks = actionTasks
      .filter((task) => task.action === 'SEND_INQUIRY' && task.targetInquiryId === inquiry.id)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const actionTaskLinkedToLatestEmail = latestEmail
      ? [...sendActionTasks].reverse().find((task) => task.outboundEmailId === latestEmail.id) ?? null
      : null;
    const sendActionTaskAfterLatestEmail = [...sendActionTasks].reverse().find((task) =>
      !latestEmail || task.createdAt.getTime() > latestEmail.createdAt.getTime());
    const currentSendActionTask = [actionTaskLinkedToLatestEmail, sendActionTaskAfterLatestEmail]
      .filter((task): task is SourcingWorkflowActionTask => Boolean(task))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
    const latestEmailStatus = normalizeSourcingToken(latestEmail?.status);
    const latestEmailAccepted = latestEmailStatus === 'SENT' || latestEmailStatus === 'SMTP_ACCEPTED';
    const latestEmailUncertain = latestEmailStatus === 'NEEDS_VERIFICATION';
    const latestEmailFailed = latestEmailStatus === 'FAILED';
    const latestEmailProcessing = ['PENDING', 'QUEUED', 'SENDING', 'PROCESSING', 'RETRYING'].includes(latestEmailStatus);
    const latestEmailWithdrawn = latestEmailStatus === 'WITHDRAWN';
    const knownEmailStatuses = latestEmailAccepted || latestEmailUncertain || latestEmailFailed || latestEmailProcessing || latestEmailWithdrawn;

    if (latestEmailUncertain) return action('NEEDS_VERIFICATION', 'VERIFY_DELIVERY');
    if (latestEmail && !knownEmailStatuses) return action('NEEDS_VERIFICATION', 'VERIFY_DELIVERY');
    if (rfqWasCancelled) return action('CANCELLED', 'STOP_CANCELLED_RFQ');
    if (currentSendActionTask) {
      const taskStatus = normalizeSourcingToken(currentSendActionTask.status);
      const taskResult = parseSendActionResult(currentSendActionTask.resultJson);
      const taskHasExecutionResult = Boolean(currentSendActionTask.outboundEmailId || currentSendActionTask.resultJson);
      if (taskStatus === 'WAITING_HUMAN') {
        if (taskHasExecutionResult) return action('NEEDS_VERIFICATION', 'VERIFY_DELIVERY');
        return action('WAITING_HUMAN', 'SEND_INQUIRY');
      }
      if (taskStatus === 'FAILED') {
        if (taskHasExecutionResult) return action('NEEDS_VERIFICATION', 'VERIFY_DELIVERY');
        return action('FAILED', 'REVIEW_BEFORE_RESEND');
      }
      if (taskStatus === 'CANCELLED') {
        if (taskHasExecutionResult) return action('NEEDS_VERIFICATION', 'VERIFY_DELIVERY');
        return action('CANCELLED', 'SEND_INQUIRY');
      }
      if (taskStatus !== 'COMPLETED'
        || !currentSendActionTask.outboundEmailId
        || taskResult?.inquiryId !== inquiry.id
        || taskResult.outboundEmailId !== currentSendActionTask.outboundEmailId
        || !inquiryEmails.some((email) => email.id === currentSendActionTask.outboundEmailId)) {
        return action('NEEDS_VERIFICATION', 'VERIFY_DELIVERY');
      }
    }
    if (latestEmailFailed) return action('FAILED', 'REVIEW_BEFORE_RESEND');
    if (latestEmailWithdrawn) return action('CANCELLED', 'REVIEW_BEFORE_RESEND');
    if (latestEmailProcessing || (!latestEmail && inquiryStatus === 'QUEUED')) {
      return action('PROCESSING', 'WAIT_FOR_PROCESSING');
    }

    const effectiveSentAt = latestEmailAccepted
      ? latestEmail?.sentAt ?? null
      : !latestEmail && inquiryStatus === 'SENT'
        ? inquiry.sentAt
        : null;
    const isLegacySent = !latestEmail && inquiryStatus === 'SENT';

    const links = [...inquiry.emailLinks].sort((left, right) => left.email.receivedAt.getTime() - right.email.receivedAt.getTime());
    const latestLink = links[links.length - 1] ?? null;
    const latestLinkIsAfterSend = latestLink
      ? latestEmailAccepted
        ? effectiveSentAt ? latestLink.email.receivedAt.getTime() >= effectiveSentAt.getTime() : null
        : true
      : false;
    if (latestLink && latestLinkIsAfterSend === null) return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
    const currentLink = latestLink && latestLinkIsAfterSend ? latestLink : null;
    if (currentLink) {
      const linkStatus = normalizeSourcingToken(currentLink.confirmationStatus);
      if (linkStatus === 'PENDING') return action('WAITING_HUMAN', 'VERIFY_REPLY_LINK');
      if (linkStatus !== 'CONFIRMED' || !currentLink.confirmedAt) return action('NEEDS_VERIFICATION', 'VERIFY_REPLY_LINK');
    }
    // When the latest send is a newer accepted version, an older response remains
    // history, not evidence that this version received a reply. Do not turn that
    // known ordering into a false link-verification error.
    if (inquiryStatus === 'RESPONDED' && !currentLink && !latestEmailAccepted) {
      return action('NEEDS_VERIFICATION', 'VERIFY_REPLY_LINK');
    }

    const draftById = new Map(inquiry.quoteDrafts.map((draft) => [draft.id, draft]));
    let hasCurrentDraft = false;
    let hasDraftBindingConflict = false;
    let hasConfirmedDraftWithoutQuote = false;
    const currentDrafts: SourcingWorkflowInquiry['quoteDrafts'] = [];
    for (const draft of inquiry.quoteDrafts) {
      const draftStatus = normalizeSourcingToken(draft.status);
      if (draftStatus !== 'DRAFT' && draftStatus !== 'CONFIRMED') continue;
      if (latestEmailAccepted) {
        if (!effectiveSentAt) {
          if (draftStatus === 'DRAFT') hasDraftBindingConflict = true;
          continue;
        }
        const sourceLink = links.find((link) => link.email.id === draft.emailId);
        if (draft.createdAt.getTime() < effectiveSentAt.getTime()
          || (sourceLink && sourceLink.email.receivedAt.getTime() < effectiveSentAt.getTime())) continue;
      }
      let payload: unknown;
      try { payload = JSON.parse(draft.payloadJson); } catch { hasDraftBindingConflict = true; continue; }
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { items?: unknown }).items)) {
        hasDraftBindingConflict = true;
        continue;
      }
      const payloadItems = (payload as { items: unknown[] }).items;
      for (const rawItem of payloadItems) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          hasDraftBindingConflict = true;
          continue;
        }
        const payloadItem = rawItem as Record<string, unknown>;
        const itemId = typeof payloadItem.inquiryItemId === 'string' ? payloadItem.inquiryItemId : '';
        const inquiryItem = inquiryItemsById.get(itemId);
        const lineReferencesMatch = ['rfqLineId', 'lineId']
          .filter((key) => key in payloadItem && payloadItem[key] != null)
          .every((key) => typeof payloadItem[key] === 'string' && payloadItem[key] === inquiryItem?.rfqLineId);
        if (!inquiryItem || !lineReferencesMatch) hasDraftBindingConflict = true;
      }
      currentDrafts.push(draft);
      if (draftStatus === 'DRAFT') hasCurrentDraft = true;
    }
    if (hasDraftBindingConflict) return action('NEEDS_VERIFICATION', 'REVIEW_DRAFT_BINDING');
    if (hasCurrentDraft) return action('WAITING_HUMAN', 'REVIEW_QUOTE_DRAFT');

    const latestCurrentLink = currentLink && normalizeSourcingToken(currentLink.confirmationStatus) === 'CONFIRMED'
      ? currentLink
      : null;
    const latestConfirmedEmailId = latestCurrentLink?.email.id ?? null;
    const currentTasks = inquiry.sourcingAiTasks
      .filter((task) => normalizeSourcingToken(task.type) === 'SUPPLIER_QUOTE_EXTRACTION'
        && latestConfirmedEmailId !== null && task.emailId === latestConfirmedEmailId)
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime());
    const latestTask = currentTasks[currentTasks.length - 1] ?? null;
    const latestTaskStatus = normalizeSourcingToken(latestTask?.status);
    if (latestTaskStatus === 'PENDING' || latestTaskStatus === 'RUNNING') return action('PROCESSING', 'WAIT_FOR_PROCESSING');
    const relevantQuotes = quotes.filter((quote) => !quote.supersededAt
      && (quote.inquiryId === inquiry.id || (quote.inquiryItemId && inquiryItemsById.has(quote.inquiryItemId))));
    const quoteIdsByItem = new Map<string, SourcingWorkflowQuote[]>();
    let hasQuoteBindingConflict = false;
    for (const quote of relevantQuotes) {
      if (quote.sourceDraftId && !draftById.has(quote.sourceDraftId)) {
        hasQuoteBindingConflict = true;
        continue;
      }
      const item = quote.inquiryItemId ? inquiryItemsById.get(quote.inquiryItemId) : undefined;
      if (quote.inquiryItemId) {
        const bindingMatches = item
          && (!quote.rfqId || quote.rfqId === rfq.id)
          && (!quote.inquiryId || quote.inquiryId === inquiry.id)
          && (!quote.rfqLineId || quote.rfqLineId === item.rfqLineId);
        if (bindingMatches) quoteIdsByItem.set(item.id, [...(quoteIdsByItem.get(item.id) ?? []), quote]);
        else if (quote.inquiryId === inquiry.id || item) hasQuoteBindingConflict = true;
        continue;
      }
      if (quote.inquiryId !== inquiry.id) continue;
      const candidates = quote.rfqLineId
        ? inquiry.items.filter((candidate) => candidate.rfqLineId === quote.rfqLineId)
        : [];
      if (candidates.length === 1
        && (!quote.rfqId || quote.rfqId === rfq.id)) {
        quoteIdsByItem.set(candidates[0].id, [...(quoteIdsByItem.get(candidates[0].id) ?? []), quote]);
      } else hasQuoteBindingConflict = true;
    }
    if (hasQuoteBindingConflict) return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');

    for (const draft of currentDrafts.filter((candidate) => normalizeSourcingToken(candidate.status) === 'CONFIRMED')) {
      const hasProducedQuote = relevantQuotes.some((quote) => quote.sourceDraftId === draft.id);
      if (!draft.confirmedAt || !hasProducedQuote) hasConfirmedDraftWithoutQuote = true;
    }
    if (hasConfirmedDraftWithoutQuote) return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');

    if (inquiry.items.length === 0) return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
    const allItemsHaveCurrentQuotes = inquiry.items.every((item) => (quoteIdsByItem.get(item.id)?.length ?? 0) > 0);
    if (allItemsHaveCurrentQuotes) {
      if (latestEmailAccepted && !effectiveSentAt) return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
      if (isLegacySent && !effectiveSentAt) return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
      const everyQuotePostdatesSend = !latestEmailAccepted && !isLegacySent || inquiry.items.every((item) =>
        (quoteIdsByItem.get(item.id) ?? []).some((quote) => {
          if (!effectiveSentAt || quote.createdAt.getTime() < effectiveSentAt.getTime()) return false;
          if (quote.sourceDraftId) {
            const sourceDraft = draftById.get(quote.sourceDraftId);
            const sourceLink = sourceDraft && links.find((link) => link.email.id === sourceDraft.emailId);
            if (sourceDraft && sourceDraft.createdAt.getTime() < effectiveSentAt.getTime()) return false;
            if (sourceLink && sourceLink.email.receivedAt.getTime() < effectiveSentAt.getTime()) return false;
          }
          return true;
        }));
      if (everyQuotePostdatesSend) return action('COMPLETED', 'REVIEW_COMPARISON');
      if (isLegacySent) return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
      if (latestEmailAccepted) return action('WAITING_REPLY', 'FOLLOW_UP_SUPPLIER');
    }

    // Persisted formal quote artifacts produced through manual recovery supersede
    // an earlier AI failure; only report failure when no completed human artifact
    // has resolved the failed task's work.
    const hasConfirmedDraft = currentDrafts.some((draft) => normalizeSourcingToken(draft.status) === 'CONFIRMED');
    if (latestTaskStatus === 'FAILED' && !hasConfirmedDraft) return action('FAILED', 'CREATE_MANUAL_DRAFT');

    if (latestTaskStatus === 'COMPLETED' && latestTask?.draftId
      && !inquiry.quoteDrafts.some((draft) => draft.id === latestTask.draftId)) {
      return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
    }
    if (latestConfirmedEmailId && latestTaskStatus === 'COMPLETED' && !latestTask?.draftId) {
      return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
    }
    if (latestConfirmedEmailId || latestTaskStatus === 'CANCELLED') {
      return action('WAITING_HUMAN', hasConfirmedDraft ? 'REVIEW_MISSING_ITEMS' : 'CREATE_MANUAL_DRAFT');
    }
    if (latestEmailAccepted || isLegacySent) {
      if (inquiryStatus === 'CLOSED') return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
      return action('WAITING_REPLY', 'FOLLOW_UP_SUPPLIER');
    }
    if (inquiryStatus === 'DRAFT') return action('WAITING_HUMAN', 'SEND_INQUIRY');
    if (inquiryStatus === 'CLOSED' || inquiryStatus === 'RESPONDED') return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
    return action('NEEDS_VERIFICATION', 'VERIFY_RECORD');
  });
}

/**
 * Project one sourcing stage per active RFQ line from explicit InquiryItem and
 * current formal-quote bindings. A line reaches COMPLETED only when every active
 * InquiryItem targeting it has a current formal quote, or a quote is directly
 * bound to the line when no InquiryItem exists. This is quote-record coverage
 * only: it says nothing about quantity sufficiency, commercial terms, selection,
 * or purchasing.
 */
function deriveLineWorkflowStates(
  rfq: { id: string; status: string },
  lines: Array<{ id: string; status: string }>,
  inquiries: SourcingWorkflowInquiry[],
  quotes: SourcingWorkflowQuote[],
  inquiryWorkflowStates: SourcingInquiryWorkflowState[],
) {
  const activeLineIds = new Set(lines
    .filter((line) => normalizeSourcingToken(line.status) !== 'CANCELLED')
    .map((line) => line.id));
  const inquiryById = new Map(inquiries.map((inquiry) => [inquiry.id, inquiry]));
  const itemById = new Map(inquiries.flatMap((inquiry) => inquiry.items.map((item) => [
    item.id,
    { inquiryId: inquiry.id, rfqLineId: item.rfqLineId },
  ] as const)));
  const currentQuoteCountByLine = new Map(lines.map((line) => [line.id, 0]));
  const coveredInquiryItemIds = new Set<string>();
  const linesNeedingVerification = new Set<string>();
  const quoteCoversCurrentSend = (quote: SourcingWorkflowQuote, inquiryId: string) => {
    const inquiry = inquiryById.get(inquiryId);
    if (!inquiry) return false;
    const latestSend = inquiry.outboundEmails
      .filter((email) => normalizeSourcingToken(email.purpose) === 'INQUIRY_SEND')
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    if (!latestSend) return true;
    if (!['SENT', 'SMTP_ACCEPTED'].includes(normalizeSourcingToken(latestSend.status)) || !latestSend.sentAt) return false;
    if (quote.createdAt.getTime() < latestSend.sentAt.getTime()) return false;
    const sourceDraft = quote.sourceDraftId
      ? inquiry.quoteDrafts.find((draft) => draft.id === quote.sourceDraftId)
      : null;
    if (sourceDraft && sourceDraft.createdAt.getTime() < latestSend.sentAt.getTime()) return false;
    const sourceLink = sourceDraft
      ? inquiry.emailLinks.find((link) => link.email.id === sourceDraft.emailId)
      : null;
    return !sourceLink || sourceLink.email.receivedAt.getTime() >= latestSend.sentAt.getTime();
  };
  const addVerificationForInquiry = (inquiryId: string | null) => {
    if (!inquiryId) return;
    for (const item of inquiryById.get(inquiryId)?.items ?? []) {
      if (item.rfqLineId && activeLineIds.has(item.rfqLineId)) linesNeedingVerification.add(item.rfqLineId);
    }
  };
  const addVerificationForLine = (rfqLineId: string | null) => {
    if (rfqLineId && activeLineIds.has(rfqLineId)) linesNeedingVerification.add(rfqLineId);
  };

  for (const quote of quotes) {
    if (quote.supersededAt) continue;
    const quoteLineId = quote.rfqLineId;
    const directItem = quote.inquiryItemId ? itemById.get(quote.inquiryItemId) : undefined;
    const inquiry = quote.inquiryId ? inquiryById.get(quote.inquiryId) : undefined;
    const candidateLineId = directItem?.rfqLineId ?? quoteLineId;
    const quoteReferencesThisRfq = !quote.rfqId || quote.rfqId === rfq.id;
    if (quote.inquiryItemId) {
      const isConsistent = directItem
        && quoteReferencesThisRfq
        && (!quote.inquiryId || quote.inquiryId === directItem.inquiryId)
        && (!quoteLineId || quoteLineId === directItem.rfqLineId)
        && (!quote.sourceDraftId || inquiryById.get(directItem.inquiryId)?.quoteDrafts.some((draft) => draft.id === quote.sourceDraftId));
      if (!isConsistent) {
        addVerificationForLine(directItem?.rfqLineId ?? quoteLineId);
        addVerificationForInquiry(quote.inquiryId);
        continue;
      }
      if (!directItem!.rfqLineId || !activeLineIds.has(directItem!.rfqLineId)) continue;
      currentQuoteCountByLine.set(directItem!.rfqLineId, (currentQuoteCountByLine.get(directItem!.rfqLineId) ?? 0) + 1);
      if (quoteCoversCurrentSend(quote, directItem!.inquiryId)) coveredInquiryItemIds.add(quote.inquiryItemId!);
      continue;
    }

    if (!quoteLineId || !activeLineIds.has(quoteLineId) || !quoteReferencesThisRfq) {
      addVerificationForLine(candidateLineId);
      addVerificationForInquiry(quote.inquiryId);
      continue;
    }
    const sourceDraftIsConsistent = !quote.sourceDraftId
      || Boolean(inquiry?.quoteDrafts.some((draft) => draft.id === quote.sourceDraftId));
    const inquiryIsConsistent = !quote.inquiryId
      || Boolean(inquiry?.items.some((item) => item.rfqLineId === quoteLineId));
    if (!sourceDraftIsConsistent || !inquiryIsConsistent) {
      addVerificationForLine(quoteLineId);
      addVerificationForInquiry(quote.inquiryId);
      continue;
    }

    currentQuoteCountByLine.set(quoteLineId, (currentQuoteCountByLine.get(quoteLineId) ?? 0) + 1);
    if (quote.inquiryId) {
      const candidates = inquiry!.items.filter((item) => item.rfqLineId === quoteLineId);
      if (candidates.length === 1 && quoteCoversCurrentSend(quote, quote.inquiryId)) coveredInquiryItemIds.add(candidates[0].id);
      else if (candidates.length > 1) addVerificationForLine(quoteLineId);
    }
  }

  const stateByInquiryId = new Map(inquiryWorkflowStates.map((state) => [state.inquiryId, state]));
  const statusPriority: Record<SourcingWorkflowStatus, number> = {
    NEEDS_VERIFICATION: 0,
    FAILED: 1,
    PROCESSING: 2,
    WAITING_HUMAN: 3,
    WAITING_REPLY: 4,
    CANCELLED: 5,
    COMPLETED: 6,
  };
  const rfqWasCancelled = normalizeSourcingToken(rfq.status) === 'CANCELLED';

  return lines.map((line) => {
    const relatedItems = inquiries.flatMap((inquiry) => inquiry.items
      .filter((item) => item.rfqLineId === line.id)
      .map((item) => ({ inquiryId: inquiry.id, itemId: item.id })));
    const inquiryIds = [...new Set(relatedItems.map((item) => item.inquiryId))];
    const activeItems = relatedItems.filter(({ inquiryId }) => stateByInquiryId.get(inquiryId)?.status !== 'CANCELLED');
    const quotedActiveItems = activeItems.filter(({ itemId }) => coveredInquiryItemIds.has(itemId)).length;
    const directQuoteCount = currentQuoteCountByLine.get(line.id) ?? 0;
    const stateFor = (status: SourcingWorkflowStatus, nextAction: SourcingWorkflowAction) => ({
      rfqLineId: line.id,
      status,
      nextAction,
      inquiryIds,
      quoteCoverage: {
        currentFormalQuoteCount: directQuoteCount,
        activeInquiryItemCount: activeItems.length,
        quotedInquiryItemCount: quotedActiveItems,
        basis: 'CURRENT_FORMAL_QUOTE_RECORDS_ONLY' as const,
        quantitySufficiencyAssessed: false as const,
        purchasingCommitted: false as const,
      },
    });

    if (rfqWasCancelled || normalizeSourcingToken(line.status) === 'CANCELLED') {
      return stateFor('CANCELLED', 'STOP_CANCELLED_RFQ');
    }
    if (linesNeedingVerification.has(line.id)) return stateFor('NEEDS_VERIFICATION', 'VERIFY_RECORD');

    const lineInquiryStates = inquiryIds
      .map((inquiryId) => stateByInquiryId.get(inquiryId))
      .filter((state): state is SourcingInquiryWorkflowState => Boolean(state));
    const pendingResend = lineInquiryStates.find((state) => state.status === 'WAITING_HUMAN' && state.nextAction === 'SEND_INQUIRY');
    if (pendingResend) return stateFor(pendingResend.status, pendingResend.nextAction);
    const hasQuoteCoverage = activeItems.length > 0
      ? quotedActiveItems === activeItems.length
      : directQuoteCount > 0;
    if (hasQuoteCoverage && (activeItems.length > 0 || directQuoteCount > 0)) {
      return stateFor('COMPLETED', 'REVIEW_COMPARISON');
    }

    const outstandingStates = lineInquiryStates
      .filter((state) => state.status !== 'COMPLETED' && state.status !== 'CANCELLED')
      .sort((left, right) => statusPriority[left.status] - statusPriority[right.status]);
    if (outstandingStates[0]) return stateFor(outstandingStates[0].status, outstandingStates[0].nextAction);
    if (lineInquiryStates.length > 0 && lineInquiryStates.every((state) => state.status === 'CANCELLED')) {
      const cancelledState = lineInquiryStates[0];
      return stateFor('CANCELLED', cancelledState.nextAction);
    }
    return stateFor('WAITING_HUMAN', 'SEND_INQUIRY');
  });
}

function parseSupplierCategoryTokens(value: string | null): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // Older supplier rows may store a comma-separated list rather than JSON.
  }
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function toRfqResponse(rfq: Awaited<ReturnType<typeof rfqRepository.findUnique>> & { customer?: { name: string }; creator?: { name: string }; lines?: RfqLine[] }) {
  if (!rfq) return null;
  return {
    id: rfq.id,
    rfqNumber: rfq.rfqNumber,
    customerId: rfq.customerId,
    customerName: rfq.customer?.name || '',
    partNumber: rfq.partNumber,
    quantity: rfq.quantity,
    uom: rfq.uom,
    conditionCode: rfq.conditionCode,
    description: rfq.description,
    serialNumber: rfq.serialNumber,
    batchNumber: rfq.batchNumber,
    ataChapter: rfq.ataChapter,
    aircraftType: rfq.aircraftType,
    aircraftModel: rfq.aircraftModel,
    alternatePartNumbers: parseAlternatePartNumbers(rfq.alternatePartNumbers),
    targetPrice: rfq.targetPrice,
    targetPriceCurrency: rfq.targetPriceCurrency,
    certificateRequired: rfq.certificateRequired,
    certificateType: rfq.certificateType,
    requiredDate: rfq.requiredDate.toISOString().split('T')[0],
    responseDeadline: rfq.responseDeadline?.toISOString().split('T')[0],
    leadTimeDays: rfq.leadTimeDays,
    urgency: rfq.urgency.toLowerCase(),
    urgencyJustification: rfq.urgencyJustification,
    status: toUiRfqStatus(preferredRfqStatus(rfq.statusEnum, rfq.status)),
    version: rfq.version,
    lineItemsMode: Boolean(rfq.lineItemsMode),
    notes: rfq.notes,
    createdAt: rfq.createdAt.toISOString(),
    createdBy: rfq.creator?.name || '',
    ...(rfq.lines ? { lines: rfq.lines.map(line => ({
      ...line,
      targetPriceDecimal: line.targetPriceDecimal?.toFixed(4) ?? null,
      requiredDate: line.requiredDate.toISOString().split('T')[0],
      alternatePartNumbers: parseAlternatePartNumbers(line.alternatePartNumbers),
      createdAt: line.createdAt.toISOString(),
      updatedAt: line.updatedAt.toISOString(),
    })) } : {}),
  };
}

function mapStatusHistoryEntry(history: {
  id: string;
  entityType: string;
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string;
  reason: string | null;
  actorId: string | null;
  version: number;
  createdAt: Date;
  actor?: { id: string; name: string } | null;
}) {
  return {
    id: history.id,
    entityType: history.entityType,
    entityId: history.entityId,
    fromStatus: history.fromStatus ? toUiRfqStatus(history.fromStatus) : null,
    toStatus: toUiRfqStatus(history.toStatus),
    reasonCode: history.reasonCode,
    reason: history.reason,
    actorId: history.actorId,
    actorName: history.actor?.name || null,
    version: history.version,
    createdAt: history.createdAt.toISOString(),
  };
}

router.get(
  '/',
  requireCapability('rfq', 'read'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const { page: pageNum, limit: pageSize, skip, sort, direction } = parseListQuery<RfqListSort>(
      query,
      {
        allowedSorts: ['createdAt', 'requiredDate', 'responseDeadline', 'rfqNumber'],
        defaultSort: 'createdAt',
        defaultDirection: 'desc',
      },
    );

    const where = buildRfqListWhere(query, (req as AuthRequest).user!);

    const [rfqs, total, statusCounts] = await Promise.all([
      rfqRepository.findMany({
        where,
        include: {
          customer: true,
          lines: { orderBy: { lineNo: 'asc' } },
          creator: {
            select: { id: true, name: true },
          },
        },
        orderBy: rfqListOrderBy(sort, direction),
        skip,
        take: pageSize,
      }),
      rfqRepository.count({ where }),
      rfqRepository.groupBy({
        where,
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const summaryCount = (statusValue: string) =>
      statusCounts.find((entry) => entry.status === statusValue)?._count._all || 0;
    const summary = {
      total: statusCounts.reduce((sum, entry) => sum + entry._count._all, 0),
      pending: summaryCount('PENDING'),
      sourcing: summaryCount('SOURCING'),
      quoting: summaryCount('QUOTING'),
      won: summaryCount('COMPLETED'),
      lost: summaryCount('CANCELLED'),
    };

    res.json({
      success: true,
      data: rfqs.map((rfq) => toRfqResponse(rfq)),
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
  })
);

router.get(
  '/export.csv',
  requireCapability('rfq', 'export'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const window = parseControlledExportWindow(query);
    const { sort, direction } = parseListQuery<RfqListSort>(query, {
      allowedSorts: ['createdAt', 'requiredDate', 'responseDeadline', 'rfqNumber'],
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });
    const rfqs = await rfqRepository.findMany({
      where: buildRfqListWhere(query, (req as AuthRequest).user!),
      select: {
        rfqNumber: true,
        lineItemsMode: true,
        lines: { orderBy: { lineNo: 'asc' }, select: { lineNo: true, partNumber: true, quantity: true, uom: true, conditionCode: true, requiredDate: true } },
        partNumber: true,
        quantity: true,
        uom: true,
        conditionCode: true,
        urgency: true,
        status: true,
        requiredDate: true,
        responseDeadline: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
      orderBy: rfqListOrderBy(sort, direction),
      skip: window.skip,
      take: window.take,
    });

    await createAuditLog({
      req,
      action: 'EXPORT',
      resourceType: 'RFQ',
      details: `RFQ CSV export (${window.scope}, ${rfqs.length}/${window.rowLimit} rows)`,
    });
    sendCsv(
      res,
      `rfqs-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { header: 'RFQ 编号', value: (rfq) => rfq.rfqNumber },
        { header: '客户', value: (rfq) => rfq.customer.name },
        { header: '件号', value: (rfq) => rfq.lineItemsMode ? null : rfq.partNumber },
        { header: '数量', value: (rfq) => rfq.lineItemsMode ? null : rfq.quantity },
        { header: '单位', value: (rfq) => rfq.lineItemsMode ? null : rfq.uom },
        { header: '条件', value: (rfq) => rfq.lineItemsMode ? null : rfq.conditionCode },
        { header: '需求行明细', value: (rfq) => rfq.lineItemsMode ? JSON.stringify(rfq.lines) : null },
        { header: '紧急度', value: (rfq) => rfq.urgency },
        { header: '状态', value: (rfq) => rfq.status },
        { header: '需求日期', value: (rfq) => rfq.lineItemsMode ? null : rfq.requiredDate },
        { header: '响应截止日期', value: (rfq) => rfq.responseDeadline },
        { header: '创建时间', value: (rfq) => rfq.createdAt },
      ],
      rfqs,
      window,
    );
  }),
);

router.get(
  '/:id/status-history',
  requireCapability('rfq', 'read'),
  asyncHandler(async (req, res) => {
    const rfq = await rfqRepository.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        status: true,
        createdBy: true,
        creator: { select: { department: true } },
      },
    });

    if (!rfq) {
      throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    assertRfqAccess((req as AuthRequest).user!, 'read', rfq);

    const history = await prisma.transactionStatusHistory.findMany({
      where: { entityType: 'RFQ', entityId: rfq.id },
      include: {
        actor: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: history.map(mapStatusHistoryEntry),
    });
  })
);

router.get(
  '/:id/sourcing-timeline',
  requireCapability('rfq', 'read'),
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const rfq = await prisma.rFQ.findFirst({
      where: { AND: [{ id: req.params.id }, buildRfqReadScope(actor)] },
      select: {
        id: true,
        status: true,
        createdBy: true,
        creator: { select: { department: true } },
        lines: {
          orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
          select: { id: true, status: true, quantity: true },
        },
      },
    });
    if (!rfq) throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
    assertRfqAccess(actor, 'read', rfq);

    const [history, inquiries, quotes] = await Promise.all([
      prisma.transactionStatusHistory.findMany({
        where: { entityType: 'RFQ', entityId: rfq.id },
        include: { actor: { select: { id: true, name: true } } },
      }),
      prisma.inquiry.findMany({
        where: { rfqId: rfq.id },
        include: {
          supplier: { select: { name: true } },
          items: { select: { id: true, rfqLineId: true, partNumber: true } },
          outboundEmails: { select: { id: true, purpose: true, status: true, createdAt: true, sentAt: true, withdrawnAt: true } },
          emailLinks: {
            include: {
              email: { select: { id: true, from: true, receivedAt: true, threadMatchStatus: true } },
              confirmedBy: { select: { id: true, name: true } },
            },
          },
          quoteDrafts: {
            include: { confirmedBy: { select: { id: true, name: true } } },
          },
          sourcingAiTasks: {
            include: { actor: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.supplierQuote.findMany({
        where: { OR: [{ rfqId: rfq.id }, { inquiry: { is: { rfqId: rfq.id } } }] },
        select: {
          id: true, rfqId: true, rfqLineId: true, inquiryId: true, sourceDraftId: true,
          inquiryItemId: true, partNumber: true, quantity: true, supersededAt: true,
          status: true, isWinner: true, createdAt: true, updatedAt: true,
          supplier: { select: { name: true } },
        },
      }),
    ]);
    const quoteById = new Map(quotes.map((quote) => [quote.id, quote]));
    const inquiryById = new Map(inquiries.map((inquiry) => [inquiry.id, inquiry]));
    const actionTaskTargets = [
      ...(inquiries.length ? [{ targetInquiryId: { in: inquiries.map((inquiry) => inquiry.id) } }] : []),
      ...(quotes.length ? [{ targetSupplierQuoteId: { in: quotes.map((quote) => quote.id) } }] : []),
    ];
    const actionTasks = actionTaskTargets.length ? await prisma.sourcingActionTask.findMany({
      where: { OR: actionTaskTargets },
      select: {
        id: true, action: true, status: true, targetInquiryId: true, targetSupplierQuoteId: true,
        outboundEmailId: true, resultJson: true, errorSummary: true, createdAt: true, updatedAt: true,
        confirmedAt: true, cancelledAt: true, retryHistoryJson: true,
        actor: { select: { id: true, name: true } },
        confirmedBy: { select: { id: true, name: true } },
        cancelledBy: { select: { id: true, name: true } },
      },
    }) : [];
    const outboundSourceById = new Map(inquiries.flatMap((inquiry) => inquiry.outboundEmails.map((outbound) => [
      outbound.id,
      {
        inquiryId: inquiry.id,
        rfqLineId: inquiry.items.length === 1 ? inquiry.items[0].rfqLineId : null,
        supplierName: inquiry.supplier.name,
      },
    ] as const)));
    const sendApprovalActions = outboundSourceById.size > 0 ? await prisma.auditLog.findMany({
      where: {
        resourceType: 'OUTBOUND_EMAIL', action: 'APPROVE', status: 'SUCCESS',
        resourceId: { in: [...outboundSourceById.keys()] },
      },
      select: { id: true, resourceId: true, userId: true, userName: true, createdAt: true },
    }) : [];
    const winnerActions = quotes.length > 0 ? await prisma.auditLog.findMany({
      where: {
        resourceType: 'SUPPLIER_QUOTE', action: 'APPROVE', status: 'SUCCESS',
        resourceId: { in: quotes.map((quote) => quote.id) },
      },
      select: { id: true, resourceId: true, userId: true, userName: true, createdAt: true },
    }) : [];
    const draftIds = inquiries.flatMap((inquiry) => inquiry.quoteDrafts.map((draft) => draft.id));
    const draftRevisionActions = draftIds.length > 0 ? await prisma.auditLog.findMany({
      where: {
        resourceType: 'SUPPLIER_QUOTE_DRAFT', action: 'UPDATE', status: 'SUCCESS',
        resourceId: { in: draftIds },
      },
      select: { id: true, resourceId: true, userId: true, userName: true, createdAt: true, changes: true },
    }) : [];
    const draftSourceById = new Map(inquiries.flatMap((inquiry) => inquiry.quoteDrafts.map((draft) => [
      draft.id,
      {
        inquiryId: inquiry.id,
        emailId: draft.emailId,
        rfqLineId: inquiry.items.length === 1 ? inquiry.items[0].rfqLineId : null,
        supplierName: inquiry.supplier.name,
      },
    ] as const)));
    const quotesWithWinnerActions = new Set(winnerActions.map((action) => action.resourceId));

    type TimelineActor = { id: string; name: string; kind: 'user' | 'external_email' } | null;
    type TimelineEvent = {
      id: string; type: string; status: string; occurredAt: string; actor: TimelineActor;
      rfqLineId?: string | null; inquiryId?: string; emailId?: string;
      outboundEmailId?: string; draftId?: string; supplierQuoteId?: string;
      actionTaskId?: string; summary: string;
      originalAiCandidates?: {
        available: boolean;
        candidateCount: number | null;
        truncated: boolean;
        items: SourcingAiCandidateSnapshotItem[];
      };
    };
    const events: TimelineEvent[] = [];
    const counts = deriveSourcingCounts(rfq.id, rfq.lines, inquiries, quotes);
    const workflowStates = deriveInquiryWorkflowStates(rfq, inquiries, quotes, actionTasks);
    const lineWorkflowStates = deriveLineWorkflowStates(rfq, rfq.lines, inquiries, quotes, workflowStates);
    const userActor = (user: { id: string; name: string } | null): TimelineActor =>
      user ? { id: user.id, name: user.name, kind: 'user' } : null;
    for (const entry of history) {
      events.push({
        id: `rfq-status:${entry.id}`, type: 'RFQ_STATUS', status: entry.toStatus,
        occurredAt: entry.createdAt.toISOString(), actor: userActor(entry.actor),
        summary: `需求状态：${entry.fromStatus || '初始'} → ${entry.toStatus}`,
      });
    }
    for (const inquiry of inquiries) {
      const onlyLineId = inquiry.items.length === 1 ? inquiry.items[0].rfqLineId : null;
      events.push({
        id: `inquiry:${inquiry.id}`, type: 'INQUIRY_CREATED', status: inquiry.status,
        occurredAt: inquiry.createdAt.toISOString(), actor: null, rfqLineId: onlyLineId,
        inquiryId: inquiry.id, summary: `已创建给 ${inquiry.supplier.name} 的询价`,
      });
      for (const outbound of inquiry.outboundEmails) {
        events.push({
          id: `outbound:${outbound.id}`, type: 'OUTBOUND_EMAIL', status: outbound.status,
          occurredAt: (outbound.sentAt || outbound.withdrawnAt || outbound.createdAt).toISOString(),
          actor: null, rfqLineId: onlyLineId, inquiryId: inquiry.id,
          outboundEmailId: outbound.id,
          summary: `给 ${inquiry.supplier.name} 的询价邮件：${outbound.status}`,
        });
      }
      for (const link of inquiry.emailLinks) {
        events.push({
          id: `inbound:${link.id}`, type: 'INBOUND_EMAIL', status: link.confirmationStatus,
          occurredAt: link.email.receivedAt.toISOString(),
          actor: { id: link.email.from, name: link.email.from, kind: 'external_email' },
          rfqLineId: onlyLineId, inquiryId: inquiry.id, emailId: link.email.id,
          summary: `${inquiry.supplier.name} 回邮（${link.email.threadMatchStatus}，关联${link.confirmationStatus}）`,
        });
        if (link.confirmedAt) {
          events.push({
            id: `inbound-confirmed:${link.id}`, type: 'INBOUND_LINK_CONFIRMED', status: link.confirmationStatus,
            occurredAt: link.confirmedAt.toISOString(), actor: userActor(link.confirmedBy),
            rfqLineId: onlyLineId, inquiryId: inquiry.id, emailId: link.email.id,
            summary: `人工确认 ${inquiry.supplier.name} 回邮关联`,
          });
        }
      }
      for (const task of inquiry.sourcingAiTasks) {
        events.push({
          id: `ai-task:${task.id}`, type: 'AI_TASK', status: task.status,
          occurredAt: (task.completedAt || task.cancelledAt || task.startedAt || task.createdAt).toISOString(),
          actor: userActor(task.actor), rfqLineId: onlyLineId, inquiryId: inquiry.id,
          emailId: task.emailId, ...(task.draftId ? { draftId: task.draftId } : {}),
          summary: `AI 回邮提取：${task.status}`,
        });
      }
      for (const draft of inquiry.quoteDrafts) {
        let aiCandidateCount: number | null = null;
        let originalCandidateSnapshot = null;
        if (draft.aiMetadataJson) {
          try {
            const metadata = JSON.parse(draft.aiMetadataJson) as { candidateCount?: unknown; originalAiCandidates?: unknown };
            if (typeof metadata.candidateCount === 'number' && Number.isInteger(metadata.candidateCount)
              && metadata.candidateCount >= 0 && metadata.candidateCount <= 100) aiCandidateCount = metadata.candidateCount;
            originalCandidateSnapshot = readOriginalAiCandidateSnapshot(metadata.originalAiCandidates);
          } catch { /* Historical metadata may be unreadable; do not invent a count. */ }
        }
        const aiSourced = Boolean(draft.aiModel || draft.aiMetadataJson);
        const originalAiCandidates = aiSourced ? {
          available: originalCandidateSnapshot !== null,
          candidateCount: originalCandidateSnapshot?.candidateCount ?? aiCandidateCount,
          truncated: originalCandidateSnapshot?.truncated ?? false,
          items: originalCandidateSnapshot?.items ?? [],
        } : undefined;
        events.push({
          id: `quote-draft:${draft.id}`, type: 'QUOTE_DRAFT', status: draft.status,
          occurredAt: draft.createdAt.toISOString(), actor: null,
          rfqLineId: onlyLineId, inquiryId: inquiry.id, emailId: draft.emailId,
          draftId: draft.id,
          ...(originalAiCandidates ? { originalAiCandidates } : {}),
          summary: aiSourced
            ? `${inquiry.supplier.name} AI 提出${aiCandidateCount === null ? '' : ` ${aiCandidateCount} 条`}报价候选草稿，待人工核对`
            : `${inquiry.supplier.name} 手工报价草稿已创建`,
        });
        if (draft.confirmedAt) {
          events.push({
            id: `quote-draft-confirmed:${draft.id}`, type: 'QUOTE_DRAFT_CONFIRMED', status: draft.status,
            occurredAt: draft.confirmedAt.toISOString(), actor: userActor(draft.confirmedBy),
            rfqLineId: onlyLineId, inquiryId: inquiry.id, emailId: draft.emailId,
            draftId: draft.id, summary: `${inquiry.supplier.name} 报价草稿已人工确认`,
          });
        }
      }
    }
    for (const quote of quotes) {
      events.push({
        id: `supplier-quote:${quote.id}`, type: 'SUPPLIER_QUOTE', status: quote.status,
        occurredAt: quote.createdAt.toISOString(), actor: null,
        rfqLineId: quote.rfqLineId, ...(quote.inquiryId ? { inquiryId: quote.inquiryId } : {}),
        ...(quote.sourceDraftId ? { draftId: quote.sourceDraftId } : {}),
        supplierQuoteId: quote.id, summary: `${quote.supplier.name} 正式报价已记录`,
      });
      if (quote.isWinner && !quotesWithWinnerActions.has(quote.id)) {
        events.push({
          id: `winner:${quote.id}`, type: 'WINNER_SELECTED', status: 'CURRENT',
          occurredAt: quote.updatedAt.toISOString(), actor: null,
          rfqLineId: quote.rfqLineId, ...(quote.inquiryId ? { inquiryId: quote.inquiryId } : {}),
          supplierQuoteId: quote.id, summary: `${quote.supplier.name} 当前中选（历史中选变更时间未单独记录）`,
        });
      }
    }
    for (const action of sendApprovalActions) {
      const source = action.resourceId ? outboundSourceById.get(action.resourceId) : null;
      if (!source) continue;
      events.push({
        id: `inquiry-send-confirmed:${action.id}`, type: 'INQUIRY_SEND_CONFIRMED', status: 'QUEUED',
        occurredAt: action.createdAt.toISOString(),
        actor: action.userId ? { id: action.userId, name: action.userName || action.userId, kind: 'user' } : null,
        rfqLineId: source.rfqLineId, inquiryId: source.inquiryId, outboundEmailId: action.resourceId!,
        summary: `人工确认给 ${source.supplierName} 的询价邮件版本并入队；实际投递结果另见发送事件`,
      });
    }
    for (const action of draftRevisionActions) {
      const source = action.resourceId ? draftSourceById.get(action.resourceId) : null;
      if (!source) continue;
      let savedVersion: number | null = null;
      if (action.changes) {
        try {
          const changes = JSON.parse(action.changes) as { version?: { after?: unknown } };
          const after = changes.version?.after;
          if (typeof after === 'number' && Number.isInteger(after) && after > 0) savedVersion = after;
        } catch { /* Historical audit payloads may not be parseable. */ }
      }
      events.push({
        id: `quote-draft-revised:${action.id}`, type: 'QUOTE_DRAFT_REVISED', status: 'SAVED',
        occurredAt: action.createdAt.toISOString(),
        actor: action.userId ? { id: action.userId, name: action.userName || action.userId, kind: 'user' } : null,
        rfqLineId: source.rfqLineId, inquiryId: source.inquiryId, emailId: source.emailId,
        draftId: action.resourceId!,
        summary: `${source.supplierName} 报价草稿已人工修订${savedVersion ? `（v${savedVersion}）` : ''}`,
      });
    }
    for (const action of winnerActions) {
      const quote = action.resourceId ? quoteById.get(action.resourceId) : null;
      if (!quote) continue;
      events.push({
        id: `winner-action:${action.id}`, type: 'WINNER_SELECTED',
        status: quote.isWinner ? 'CURRENT' : 'SUPERSEDED',
        occurredAt: action.createdAt.toISOString(),
        actor: action.userId ? { id: action.userId, name: action.userName || action.userId, kind: 'user' } : null,
        rfqLineId: quote.rfqLineId,
        ...(quote.inquiryId ? { inquiryId: quote.inquiryId } : {}),
        supplierQuoteId: quote.id,
        summary: `${quote.supplier.name} ${quote.isWinner ? '当前中选' : '曾被选中，现已更换'}`,
      });
    }
    for (const task of actionTasks) {
      const inquiry = task.targetInquiryId ? inquiryById.get(task.targetInquiryId) : null;
      const quote = task.targetSupplierQuoteId ? quoteById.get(task.targetSupplierQuoteId) : null;
      if (!inquiry && !quote) continue;
      const inquiryId = inquiry?.id ?? quote?.inquiryId ?? undefined;
      const rfqLineId = inquiry
        ? (inquiry.items.length === 1 ? inquiry.items[0].rfqLineId : null)
        : quote?.rfqLineId ?? null;
      const subject = task.action === 'SEND_INQUIRY' ? '询价发送' : '报价中选';
      const links = {
        actionTaskId: task.id,
        rfqLineId,
        ...(inquiryId ? { inquiryId } : {}),
        ...(quote ? { supplierQuoteId: quote.id } : {}),
      };
      events.push({
        id: `action-task-created:${task.id}`, type: 'ACTION_TASK', status: 'WAITING_HUMAN',
        occurredAt: task.createdAt.toISOString(), actor: userActor(task.actor),
        ...links, summary: `${subject}任务已创建，等待人工确认具体版本`,
      });
      if (task.retryHistoryJson) {
        try {
          const history = JSON.parse(task.retryHistoryJson) as unknown;
          if (Array.isArray(history)) {
            for (const [index, retry] of history.entries()) {
              if (!retry || typeof retry !== 'object') continue;
              const entry = retry as Record<string, unknown>;
              if (typeof entry.actorId !== 'string' || typeof entry.occurredAt !== 'string'
                || Number.isNaN(new Date(entry.occurredAt).getTime())) continue;
              events.push({
                id: `action-task-retry:${task.id}:${index}`, type: 'ACTION_TASK', status: 'WAITING_HUMAN',
                occurredAt: entry.occurredAt,
                actor: { id: entry.actorId, name: entry.actorId, kind: 'user' },
                ...links, summary: `${subject}任务已人工重试，仍需重新确认`,
              });
            }
          }
        } catch { /* An unreadable historical retry log is not invented. */ }
      }
      if (task.status === 'COMPLETED' && task.confirmedAt) {
        events.push({
          id: `action-task-confirmed:${task.id}`, type: 'ACTION_TASK', status: 'COMPLETED',
          occurredAt: task.confirmedAt.toISOString(), actor: userActor(task.confirmedBy),
          ...links,
          ...(task.outboundEmailId ? { outboundEmailId: task.outboundEmailId } : {}),
          summary: task.action === 'SEND_INQUIRY'
            ? '人工确认询价发送任务，邮件已入队；实际投递结果另见发送事件'
            : '人工确认报价中选任务，内部中选结果已提交',
        });
      } else if (task.status === 'CANCELLED' && task.cancelledAt) {
        events.push({
          id: `action-task-cancelled:${task.id}`, type: 'ACTION_TASK', status: 'CANCELLED',
          occurredAt: task.cancelledAt.toISOString(), actor: userActor(task.cancelledBy),
          ...links, summary: `${subject}任务已人工取消，未执行`,
        });
      } else if (task.status === 'FAILED') {
        events.push({
          id: `action-task-failed:${task.id}`, type: 'ACTION_TASK', status: 'FAILED',
          occurredAt: task.updatedAt.toISOString(), actor: null,
          ...links, summary: `${subject}任务失败（${task.errorSummary || '原因待核实'}），未执行`,
        });
      }
    }
    events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    res.json({ success: true, data: { rfqId: rfq.id, events, counts, workflowStates, lineWorkflowStates } });
  }),
);

router.get(
  '/:id/sourcing-candidates',
  requireCapability('rfq', 'read'),
  requireCapability('supplier', 'read'),
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const rfq = await prisma.rFQ.findFirst({
      where: {
        AND: [
          { id: req.params.id },
          buildRfqReadScope(actor),
        ],
      },
      select: {
        id: true,
        rfqNumber: true,
        createdBy: true,
        lineItemsMode: true,
        partNumber: true,
        quantity: true,
        uom: true,
        conditionCode: true,
        description: true,
        ataChapter: true,
        status: true,
        statusEnum: true,
        creator: { select: { department: true } },
        lines: {
          orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
          take: MAX_RFQ_SOURCING_LINES + 1,
          select: {
            id: true,
            lineNo: true,
            partNumber: true,
            quantity: true,
            uom: true,
            conditionCode: true,
            description: true,
            ataChapter: true,
            status: true,
          },
        },
      },
    });

    if (!rfq) throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
    assertRfqAccess(actor, 'read', rfq);
    if (rfq.lines.length > MAX_RFQ_SOURCING_LINES) {
      throw new AppError('RFQ需求行过多，无法一次生成供应商候选', 413, 'VALIDATION_ERROR');
    }

    const demandLines = rfq.lines.length > 0
      ? rfq.lines
        .filter((line) => normalizeSourcingToken(line.status) !== 'CANCELLED')
        .map((line) => ({
          id: line.id,
          rfqLineId: line.id,
          identitySource: 'RFQ_LINE' as const,
          lineNo: line.lineNo,
          partNumber: line.partNumber,
          quantity: line.quantity,
          uom: line.uom,
          conditionCode: line.conditionCode,
          description: line.description,
          ataChapter: line.ataChapter,
        }))
      : (!rfq.lineItemsMode && preferredRfqStatus(rfq.statusEnum, rfq.status).toUpperCase() !== 'CANCELLED'
        ? [{
            id: `rfq-header:${rfq.id}`,
            rfqLineId: null,
            identitySource: 'RFQ_HEADER' as const,
            lineNo: 1,
            partNumber: rfq.partNumber,
            quantity: rfq.quantity,
            uom: rfq.uom,
            conditionCode: rfq.conditionCode,
            description: rfq.description,
            ataChapter: rfq.ataChapter,
          }]
        : []);

    const partNumbers = [...new Set(demandLines.map((line) => line.partNumber.trim()).filter(Boolean))];
    if (partNumbers.length === 0) {
      res.json({
        success: true,
        data: {
          rfqId: rfq.id,
          rfqNumber: rfq.rfqNumber,
          evidenceSemantics: {
            historicalQuotesAreNotCurrentOffers: true,
            inventoryAttributionIsNotCurrentAvailability: true,
            supplierCategoriesAreProfileDeclarations: true,
            currentAvailabilityVerified: false,
            currentPricingVerified: false,
            supplyCommitmentCreated: false,
          },
          lines: [],
          limits: { candidatesPerLine: MAX_RFQ_SOURCING_CANDIDATES_PER_LINE, evidenceTruncated: false },
        },
      });
      return;
    }

    const normalizedPartNumbers = [...new Set(partNumbers.map(normalizeSourcingToken))];
    const [quoteEvidenceRows, inventorySourceRows] = await Promise.all([
      prisma.supplierQuote.findMany({
        where: { partNumber: { in: partNumbers, mode: 'insensitive' } },
        select: {
          id: true,
          supplierId: true,
          partNumber: true,
          quantity: true,
          status: true,
          statusEnum: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_RFQ_SOURCING_EVIDENCE_PER_SOURCE + 1,
      }),
      prisma.inventoryDetail.findMany({
        where: {
          supplierId: { not: null },
          inventoryItem: { is: { partNumber: { in: partNumbers, mode: 'insensitive' } } },
        },
        select: {
          id: true,
          supplierId: true,
          createdAt: true,
          inventoryItem: { select: { partNumber: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_RFQ_SOURCING_EVIDENCE_PER_SOURCE + 1,
      }),
    ]);

    const quoteEvidenceTruncated = quoteEvidenceRows.length > MAX_RFQ_SOURCING_EVIDENCE_PER_SOURCE;
    const inventoryEvidenceTruncated = inventorySourceRows.length > MAX_RFQ_SOURCING_EVIDENCE_PER_SOURCE;
    const quotes = quoteEvidenceRows.slice(0, MAX_RFQ_SOURCING_EVIDENCE_PER_SOURCE);
    const inventorySources = inventorySourceRows.slice(0, MAX_RFQ_SOURCING_EVIDENCE_PER_SOURCE);

    type SourcingEvidence = Record<string, string | number | boolean | null>;
    type SupplierCandidateAccumulator = { supplierId: string; evidence: SourcingEvidence[] };
    const candidatesByPart = new Map<string, Map<string, SupplierCandidateAccumulator>>();
    const categoryCandidatesByLine = new Map<string, Map<string, SupplierCandidateAccumulator>>();
    const ensureCandidate = (partNumber: string, supplierId: string) => {
      const normalizedPartNumber = normalizeSourcingToken(partNumber);
      if (!normalizedPartNumbers.includes(normalizedPartNumber)) return null;
      let candidates = candidatesByPart.get(normalizedPartNumber);
      if (!candidates) {
        candidates = new Map();
        candidatesByPart.set(normalizedPartNumber, candidates);
      }
      let candidate = candidates.get(supplierId);
      if (!candidate) {
        candidate = { supplierId, evidence: [] };
        candidates.set(supplierId, candidate);
      }
      return candidate;
    };

    for (const quote of quotes) {
      const candidate = ensureCandidate(quote.partNumber, quote.supplierId);
      if (!candidate || candidate.evidence.some((item) => item.type === 'HISTORICAL_SUPPLIER_QUOTE')) continue;
      candidate.evidence.push({
        type: 'HISTORICAL_SUPPLIER_QUOTE',
        recordId: quote.id,
        partNumber: quote.partNumber,
        quantity: quote.quantity,
        recordedStatus: preferredSupplierQuoteStatus(quote.statusEnum, quote.status),
        recordedAt: quote.createdAt.toISOString(),
        currentOfferVerified: false,
      });
    }

    for (const source of inventorySources) {
      if (!source.supplierId) continue;
      const candidate = ensureCandidate(source.inventoryItem.partNumber, source.supplierId);
      if (!candidate || candidate.evidence.some((item) => item.type === 'INVENTORY_SUPPLIER_ATTRIBUTION')) continue;
      candidate.evidence.push({
        type: 'INVENTORY_SUPPLIER_ATTRIBUTION',
        recordId: source.id,
        sourceField: 'InventoryDetail.supplierId',
        partNumber: source.inventoryItem.partNumber,
        recordedAt: source.createdAt.toISOString(),
        currentAvailabilityVerified: false,
      });
    }

    const supplierIds = [...new Set([
      ...quotes.map((quote) => quote.supplierId),
      ...inventorySources.map((source) => source.supplierId).filter((id): id is string => Boolean(id)),
    ])];
    const ataChapters = [...new Set(demandLines.map((line) => normalizeSourcingToken(line.ataChapter)).filter(Boolean))];
    const [sourceSupplierProfiles, categorySupplierProfiles] = await Promise.all([
      supplierIds.length > 0
        ? prisma.supplier.findMany({
          where: { id: { in: supplierIds } },
          select: {
            id: true,
            name: true,
            status: true,
            level: true,
            approvedPartCategories: true,
            updatedAt: true,
          },
          orderBy: [{ id: 'asc' }],
          take: supplierIds.length,
        })
        : Promise.resolve([]),
      ataChapters.length > 0
        ? prisma.supplier.findMany({
          where: {
            OR: ataChapters.map((chapter) => ({
              approvedPartCategories: { contains: JSON.stringify(chapter), mode: 'insensitive' },
            })),
          },
          select: {
            id: true,
            name: true,
            status: true,
            level: true,
            approvedPartCategories: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: MAX_RFQ_SOURCING_CATEGORY_PROFILES + 1,
        })
        : Promise.resolve([]),
    ]);
    const categoryProfilesTruncated = categorySupplierProfiles.length > MAX_RFQ_SOURCING_CATEGORY_PROFILES;
    const supplierById = new Map(
      [...sourceSupplierProfiles, ...categorySupplierProfiles.slice(0, MAX_RFQ_SOURCING_CATEGORY_PROFILES)]
        .map((supplier) => [supplier.id, supplier]),
    );

    for (const line of demandLines) {
      const lineChapter = normalizeSourcingToken(line.ataChapter);
      if (!lineChapter) continue;
      for (const supplier of categorySupplierProfiles.slice(0, MAX_RFQ_SOURCING_CATEGORY_PROFILES)) {
        const matchedCategory = parseSupplierCategoryTokens(supplier.approvedPartCategories)
          .find((category) => normalizeSourcingToken(category) === lineChapter);
        if (!matchedCategory) continue;
        let candidates = categoryCandidatesByLine.get(line.id);
        if (!candidates) {
          candidates = new Map();
          categoryCandidatesByLine.set(line.id, candidates);
        }
        let candidate = candidates.get(supplier.id);
        if (!candidate) {
          candidate = { supplierId: supplier.id, evidence: [] };
          candidates.set(supplier.id, candidate);
        }
        if (candidate.evidence.some((item) => item.type === 'SUPPLIER_PROFILE_CATEGORY')) continue;
        candidate.evidence.push({
          type: 'SUPPLIER_PROFILE_CATEGORY',
          profileField: 'approvedPartCategories',
          matchedCategory,
          matchedAgainst: `RFQ line ATA chapter ${line.ataChapter}`,
          profileUpdatedAt: supplier.updatedAt.toISOString(),
          currentSupplyPromiseVerified: false,
        });
      }
    }

    const responseLines = demandLines.map((line) => {
      const candidatesBySupplier = new Map<string, SupplierCandidateAccumulator>();
      for (const candidate of candidatesByPart.get(normalizeSourcingToken(line.partNumber))?.values() ?? []) {
        candidatesBySupplier.set(candidate.supplierId, { supplierId: candidate.supplierId, evidence: [...candidate.evidence] });
      }
      for (const categoryCandidate of categoryCandidatesByLine.get(line.id)?.values() ?? []) {
        const candidate = candidatesBySupplier.get(categoryCandidate.supplierId);
        if (candidate) candidate.evidence.push(...categoryCandidate.evidence);
        else candidatesBySupplier.set(categoryCandidate.supplierId, categoryCandidate);
      }
      const candidates = [...candidatesBySupplier.values()]
        .filter((candidate) => supplierById.has(candidate.supplierId))
        .sort((left, right) => {
          const leftSupplier = supplierById.get(left.supplierId)!;
          const rightSupplier = supplierById.get(right.supplierId)!;
          return leftSupplier.name.localeCompare(rightSupplier.name) || leftSupplier.id.localeCompare(rightSupplier.id);
        });
      const candidateCount = candidates.length;
      const visibleCandidates = candidates.slice(0, MAX_RFQ_SOURCING_CANDIDATES_PER_LINE);
      return {
        id: line.id,
        rfqLineId: line.rfqLineId,
        identitySource: line.identitySource,
        lineNo: line.lineNo,
        partNumber: line.partNumber,
        quantity: line.quantity,
        uom: line.uom,
        conditionCode: line.conditionCode,
        description: line.description,
        ataChapter: line.ataChapter,
        sourcingStatus: candidateCount > 0 ? 'EVIDENCE_FOUND' : 'INQUIRY_REQUIRED',
        candidateCount,
        candidatesTruncated: candidateCount > MAX_RFQ_SOURCING_CANDIDATES_PER_LINE,
        candidates: visibleCandidates.map((candidate) => {
          const supplier = supplierById.get(candidate.supplierId)!;
          return {
            supplier: { id: supplier.id, name: supplier.name, status: supplier.status, level: supplier.level },
            evidence: candidate.evidence,
            currentSupplyPromiseVerified: false,
          };
        }),
      };
    });

    res.json({
      success: true,
      data: {
        rfqId: rfq.id,
        rfqNumber: rfq.rfqNumber,
        evidenceSemantics: {
          historicalQuotesAreNotCurrentOffers: true,
          inventoryAttributionIsNotCurrentAvailability: true,
          supplierCategoriesAreProfileDeclarations: true,
          currentPricingVerified: false,
          supplyCommitmentCreated: false,
        },
        lines: responseLines,
        limits: {
          candidatesPerLine: MAX_RFQ_SOURCING_CANDIDATES_PER_LINE,
          evidenceTruncated: quoteEvidenceTruncated || inventoryEvidenceTruncated || categoryProfilesTruncated,
        },
      },
    });
  }),
);

router.get(
  '/:id',
  requireCapability('rfq', 'read'),
  asyncHandler(async (req, res) => {
    const rfq = await rfqRepository.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        creator: {
          select: { id: true, name: true, department: true },
        },
        quotations: true,
        lines: { orderBy: { lineNo: 'asc' } },
      },
    });

    if (!rfq) {
      throw new AppError('RFQ不存在', 404);
    }
    assertRfqAccess((req as AuthRequest).user!, 'read', rfq);

    res.json({
      success: true,
      data: {
        ...toRfqResponse(rfq),
        quotations: rfq.quotations.map((q) => ({
          id: q.id,
          quoteNumber: q.quoteNumber,
          status: preferredQuotationStatus(q.statusEnum, q.status).toLowerCase(),
        })),
      },
    });
  })
);

router.post(
  '/',
  requireCapability('rfq', 'create'),
  validateBody(rfqCreateSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as any;
    const {
      customerId,
      partNumber,
      quantity,
      uom,
      conditionCode,
      description,
      serialNumber,
      batchNumber,
      ataChapter,
      aircraftType,
      aircraftModel,
      alternatePartNumbers,
      targetPrice,
      targetPriceCurrency,
      certificateRequired,
      certificateType,
      requiredDate,
      responseDeadline,
      leadTimeDays,
      urgency,
      urgencyJustification,
      notes,
      emailId,
    } = input;

    const userId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, userId, 'POST:/rfqs'),
      async (tx) => {
        const created = await createRfqAggregate(tx, {
          customerId,
          partNumber,
          quantity,
          uom,
          conditionCode,
          description,
          serialNumber,
          batchNumber,
          ataChapter,
          aircraftType,
          aircraftModel,
          alternatePartNumbers,
          targetPrice,
          targetPriceCurrency,
          certificateRequired,
          certificateType,
          requiredDate: requiredDate ? new Date(requiredDate) : new Date(),
          responseDeadline: responseDeadline ? new Date(responseDeadline) : undefined,
          leadTimeDays,
          urgency: urgency?.toUpperCase() || 'STANDARD',
          urgencyJustification,
          notes,
          emailId,
          createdBy: userId,
          ...(input.lines ? { lines: input.lines } : {}),
        }, userId);

        await enqueueBusinessEvent(tx, {
          eventType: 'rfq.created',
          aggregateType: 'RFQ',
          aggregateId: created.id,
          data: {
            rfqId: created.id,
            rfqNumber: created.rfqNumber,
            customerId: created.customerId,
            customerName: created.customer.name,
            partNumber: created.partNumber,
            quantity: created.quantity,
            requiredDate: created.requiredDate.toISOString(),
            urgency: created.urgency,
            status: created.status,
            createdBy: userId,
          },
          socket: {
            room: SocketRooms.RFQS,
            event: SocketEvents.RFQ_CREATED,
          },
          createdById: userId,
        });

        return {
          payload: toRfqResponse(created),
          statusCode: 201,
          resourceType: 'RFQ',
          resourceId: created.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.patch(
  '/:id',
  requireCapability('rfq', 'update'),
  validateBody(rfqUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const updateData: Parameters<typeof updateRfqAggregate>[2] = {};
    const fields: string[] = [
      'customerId',
      'partNumber',
      'quantity',
      'uom',
      'conditionCode',
      'description',
      'serialNumber',
      'batchNumber',
      'ataChapter',
      'aircraftType',
      'aircraftModel',
      'alternatePartNumbers',
      'targetPrice',
      'targetPriceCurrency',
      'certificateRequired',
      'certificateType',
      'leadTimeDays',
      'urgency',
      'urgencyJustification',
      'notes',
    ];

    fields.forEach((field) => {
      if (field in req.body) {
        (updateData as Record<string, unknown>)[field] = (req.body as Record<string, unknown>)[field];
      }
    });

    if (req.body.requiredDate) {
      updateData.requiredDate = new Date(req.body.requiredDate);
    }
    if (req.body.responseDeadline) {
      updateData.responseDeadline = new Date(req.body.responseDeadline);
    }
    if (req.body.urgency) {
      updateData.urgency = req.body.urgency.toUpperCase();
    }
    if (req.body.lines) {
      updateData.lines = req.body.lines;
    }

    const userId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, userId, 'PATCH:/rfqs/:id'),
      async (tx) => {
        const existing = await tx.rFQ.findUnique({
          where: { id },
          include: { creator: { select: { department: true } } },
        });
        if (!existing) {
          throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertRfqAccess((req as AuthRequest).user!, 'update', existing);

        const rfq = await updateRfqAggregate(tx, id, updateData);

        return {
          payload: toRfqResponse(rfq),
          resourceType: 'RFQ',
          resourceId: rfq.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.patch(
  '/:id/status',
  requireCapability('rfq', 'transition'),
  validateBody(rfqStatusUpdateSchema),
  asyncHandler(async (req, res) => {
    const nextStatus = String(req.body.status);
    const userId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, userId, 'PATCH:/rfqs/:id/status'),
      async (tx) => {
        const current = await tx.rFQ.findUnique({
          where: { id: req.params.id },
          include: { creator: { select: { department: true } } },
        });
        if (!current) {
          throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertRfqAccess((req as AuthRequest).user!, 'transition', current);

        const effectiveCurrentStatus = preferredRfqStatus(current.statusEnum, current.status);
        const currentStatus = normalizeRfqStatus(effectiveCurrentStatus);
        const normalizedNextStatus = assertRfqTransition(effectiveCurrentStatus, nextStatus);

        const isNoop = currentStatus === normalizedNextStatus;
        const rfq = isNoop
          ? await tx.rFQ.findUnique({
            where: { id: req.params.id },
            include: {
              customer: true,
              creator: {
                select: { id: true, name: true },
              },
            },
          })
          : await (async () => {
            await transitionRfqStatus(tx, {
              id: current.id,
              currentStatus: current.status,
              currentVersion: current.version,
              nextStatus: normalizedNextStatus,
              expectedVersion: req.body.version,
              actorId: userId,
              reasonCode: req.body.reasonCode || 'MANUAL_STATUS_UPDATE',
              reason: req.body.reason,
            });

            return tx.rFQ.findUnique({
              where: { id: req.params.id },
              include: {
                customer: true,
                creator: {
                  select: { id: true, name: true },
                },
              },
            });
          })();

        if (!rfq) {
          throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
        }

        if (!isNoop) {
          await enqueueBusinessEvent(tx, {
            eventType: 'rfq.status.changed',
            aggregateType: 'RFQ',
            aggregateId: rfq.id,
            data: {
              rfqId: rfq.id,
              rfqNumber: rfq.rfqNumber,
              oldStatus: effectiveCurrentStatus,
              newStatus: preferredRfqStatus(rfq.statusEnum, rfq.status),
              changedBy: userId,
              changedAt: new Date().toISOString(),
            },
            socket: {
              room: SocketRooms.RFQS,
              event: SocketEvents.RFQ_UPDATED,
            },
            createdById: userId,
          });
        }

        return {
          payload: toRfqResponse(rfq),
          resourceType: 'RFQ',
          resourceId: rfq.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  }),
);

export default router;
