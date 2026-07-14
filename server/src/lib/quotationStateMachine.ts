export const QUOTATION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SENT',
  'ACCEPTED',
  'EXPIRED',
  'WITHDRAWN',
] as const;

export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

const STATUS_ALIASES: Record<string, QuotationStatus> = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  PENDINGAPPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SENT: 'SENT',
  ACCEPTED: 'ACCEPTED',
  EXPIRED: 'EXPIRED',
  WITHDRAWN: 'WITHDRAWN',
};

export const QUOTATION_ALLOWED_TRANSITIONS: Record<QuotationStatus, readonly QuotationStatus[]> = {
  DRAFT: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['SENT', 'ACCEPTED'],
  REJECTED: ['PENDING_APPROVAL'],
  SENT: ['SENT', 'ACCEPTED', 'WITHDRAWN'],
  ACCEPTED: ['ACCEPTED'],
  EXPIRED: [],
  WITHDRAWN: [],
};

export function normalizeQuotationStatus(value: unknown): QuotationStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[-\s]+/g, '_').toUpperCase();
  return STATUS_ALIASES[normalized] || null;
}

export function isQuotationTransitionAllowed(from: unknown, to: unknown): boolean {
  const current = normalizeQuotationStatus(from);
  const target = normalizeQuotationStatus(to);

  if (!current || !target) return false;
  return current === target || QUOTATION_ALLOWED_TRANSITIONS[current].includes(target);
}
