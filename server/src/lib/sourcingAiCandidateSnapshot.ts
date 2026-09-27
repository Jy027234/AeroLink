const MAX_ORIGINAL_AI_CANDIDATES = 100;
const MAX_SAFE_ID_LENGTH = 128;
const MAX_SAFE_PART_NUMBER_LENGTH = 120;
const MAX_SAFE_QUANTITY_UNIT_LENGTH = 80;
const MAX_SAFE_INCOTERM_LENGTH = 20;
const MAX_CANDIDATE_NUMBER = 1_000_000_000;

export type SourcingAiCandidatePayloadItem = {
  itemKey?: string;
  inquiryItemId?: string | null;
  partNumber?: string | null;
  quantity?: number | null;
  quantityUnit?: string | null;
  unitPrice?: number | null;
  currency?: string | null;
  leadTimeDays?: number | null;
  leadTimeMinDays?: number | null;
  leadTimeMaxDays?: number | null;
  validUntil?: string | null;
  taxIncluded?: boolean | null;
  freightIncluded?: boolean | null;
  incoterm?: string | null;
};

export type SourcingAiCandidateSnapshotItem = {
  itemKey: string | null;
  inquiryItemId: string | null;
  partNumber: string | null;
  quantity: number | null;
  quantityUnit: string | null;
  unitPrice: number | null;
  currency: string | null;
  leadTimeDays: number | null;
  leadTimeMinDays: number | null;
  leadTimeMaxDays: number | null;
  validUntil: string | null;
  taxIncluded: boolean | null;
  freightIncluded: boolean | null;
  incoterm: string | null;
};

export type SourcingAiCandidateSnapshot = {
  schemaVersion: 1;
  candidateCount: number;
  truncated: boolean;
  items: SourcingAiCandidateSnapshotItem[];
};

export function createOriginalAiCandidateSnapshot(
  candidates: readonly SourcingAiCandidatePayloadItem[],
): SourcingAiCandidateSnapshot {
  const items = candidates.slice(0, MAX_ORIGINAL_AI_CANDIDATES).map((candidate) => ({
    itemKey: safeIdentifier(candidate.itemKey),
    inquiryItemId: safeIdentifier(candidate.inquiryItemId),
    partNumber: safePartNumber(candidate.partNumber),
    quantity: safeNumber(candidate.quantity, true),
    quantityUnit: safeQuantityUnit(candidate.quantityUnit),
    unitPrice: safeNumber(candidate.unitPrice, false),
    currency: safeCurrency(candidate.currency),
    leadTimeDays: safeNumber(candidate.leadTimeDays, false),
    leadTimeMinDays: safeNumber(candidate.leadTimeMinDays, false),
    leadTimeMaxDays: safeNumber(candidate.leadTimeMaxDays, false),
    validUntil: safeCalendarDate(candidate.validUntil),
    taxIncluded: safeBoolean(candidate.taxIncluded),
    freightIncluded: safeBoolean(candidate.freightIncluded),
    incoterm: safeIncoterm(candidate.incoterm),
  }));

  return {
    schemaVersion: 1,
    candidateCount: Math.min(candidates.length, MAX_ORIGINAL_AI_CANDIDATES),
    truncated: candidates.length > MAX_ORIGINAL_AI_CANDIDATES,
    items,
  };
}

/** Validate and re-project persisted metadata before it crosses the RFQ API boundary. */
export function readOriginalAiCandidateSnapshot(value: unknown): SourcingAiCandidateSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.items)) return null;
  if (!Number.isInteger(value.candidateCount) || (value.candidateCount as number) < 0
    || (value.candidateCount as number) > MAX_ORIGINAL_AI_CANDIDATES) return null;

  const items = value.items.slice(0, MAX_ORIGINAL_AI_CANDIDATES).map((candidate) => {
    if (!isRecord(candidate)) return null;
    return {
      itemKey: safeIdentifier(candidate.itemKey),
      inquiryItemId: safeIdentifier(candidate.inquiryItemId),
      partNumber: safePartNumber(candidate.partNumber),
      quantity: safeNumber(candidate.quantity, true),
      quantityUnit: safeQuantityUnit(candidate.quantityUnit),
      unitPrice: safeNumber(candidate.unitPrice, false),
      currency: safeCurrency(candidate.currency),
      leadTimeDays: safeNumber(candidate.leadTimeDays, false),
      leadTimeMinDays: safeNumber(candidate.leadTimeMinDays, false),
      leadTimeMaxDays: safeNumber(candidate.leadTimeMaxDays, false),
      validUntil: safeCalendarDate(candidate.validUntil),
      taxIncluded: safeBoolean(candidate.taxIncluded),
      freightIncluded: safeBoolean(candidate.freightIncluded),
      incoterm: safeIncoterm(candidate.incoterm),
    } satisfies SourcingAiCandidateSnapshotItem;
  });

  if (items.some((item) => item === null)) return null;
  return {
    schemaVersion: 1,
    candidateCount: value.candidateCount as number,
    truncated: value.truncated === true || (value.candidateCount as number) > items.length
      || value.items.length > MAX_ORIGINAL_AI_CANDIDATES,
    items: items as SourcingAiCandidateSnapshotItem[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_SAFE_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : null;
}

function safePartNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_SAFE_PART_NUMBER_LENGTH
    && /^[\p{L}\p{N}][\p{L}\p{N} ._/+()-]*$/u.test(normalized) ? normalized : null;
}

function safeQuantityUnit(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_SAFE_QUANTITY_UNIT_LENGTH
    && /^[A-Za-z0-9._/+-]+$/.test(normalized) ? normalized : null;
}

function safeCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

function safeIncoterm(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 2 && value.length <= MAX_SAFE_INCOTERM_LENGTH
    && /^[A-Za-z0-9-]+$/.test(value) ? value.toUpperCase() : null;
}

function safeCalendarDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function safeNumber(value: unknown, positive: boolean): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= (positive ? Number.MIN_VALUE : 0) && value <= MAX_CANDIDATE_NUMBER ? value : null;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
