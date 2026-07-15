export const RFQ_STATUSES = [
  'PENDING',
  'SOURCING',
  'QUOTING',
  'APPROVING',
  'ORDERED',
  'COMPLETED',
  'CANCELLED',
] as const;

export type RFQStatus = (typeof RFQ_STATUSES)[number];

const STATUS_ALIASES: Record<string, RFQStatus> = {
  PENDING: 'PENDING',
  SOURCING: 'SOURCING',
  QUOTING: 'QUOTING',
  APPROVING: 'APPROVING',
  APPROVED: 'APPROVING',
  ORDERED: 'ORDERED',
  SENT: 'ORDERED',
  COMPLETED: 'COMPLETED',
  WON: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  CANCELED: 'CANCELLED',
  LOST: 'CANCELLED',
};

export const RFQ_ALLOWED_TRANSITIONS: Record<RFQStatus, readonly RFQStatus[]> = {
  PENDING: ['SOURCING', 'QUOTING', 'CANCELLED'],
  SOURCING: ['QUOTING', 'CANCELLED'],
  QUOTING: ['APPROVING', 'ORDERED', 'COMPLETED', 'CANCELLED'],
  APPROVING: ['ORDERED', 'COMPLETED', 'CANCELLED'],
  ORDERED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function normalizeRfqStatus(value: unknown): RFQStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[-\s]+/g, '_').toUpperCase();
  return STATUS_ALIASES[normalized] || null;
}

export function isRfqStatusTransitionAllowed(from: unknown, to: unknown): boolean {
  const current = normalizeRfqStatus(from);
  const target = normalizeRfqStatus(to);

  if (!current || !target) return false;
  return current === target || RFQ_ALLOWED_TRANSITIONS[current].includes(target);
}

export function toUiRfqStatus(status: string): string {
  const normalized = normalizeRfqStatus(status);
  const labels: Record<RFQStatus, string> = {
    PENDING: 'pending',
    SOURCING: 'sourcing',
    QUOTING: 'quoting',
    APPROVING: 'approved',
    ORDERED: 'sent',
    COMPLETED: 'won',
    CANCELLED: 'lost',
  };

  return normalized ? labels[normalized] : status.toLowerCase();
}
