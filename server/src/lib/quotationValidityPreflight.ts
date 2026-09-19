export type QuotationValidityRecord = {
  id: string;
  quoteNumber: string;
  version: number;
  status: string;
  expiryDate: Date | string | null;
  validityDeadline: Date | string | null;
  createdAt: Date | string;
};

function instant(value: Date | string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** Diagnostic only: never infer a replacement date from validityDays or now. */
export function checkQuotationValidity(records: QuotationValidityRecord[], now = new Date()) {
  const issues: Array<{
    id: string; quoteNumber: string; version: number; status: string;
    code: 'INVALID_EXPIRY' | 'INVALID_DEADLINE' | 'DEADLINE_CONFLICT';
    expiryDate: string | null; validityDeadline: string | null;
    possibleCreationDefault: boolean;
  }> = [];
  let expired = 0;
  for (const record of records) {
    const expiry = instant(record.expiryDate);
    const deadline = instant(record.validityDeadline);
    const created = instant(record.createdAt);
    if (expiry !== null && expiry <= now.getTime()) expired += 1;
    const code = expiry === null ? 'INVALID_EXPIRY'
      : deadline === null ? 'INVALID_DEADLINE'
        : expiry !== deadline ? 'DEADLINE_CONFLICT' : null;
    if (code) issues.push({
      id: record.id, quoteNumber: record.quoteNumber, version: record.version, status: record.status, code,
      expiryDate: expiry === null ? null : new Date(expiry).toISOString(),
      validityDeadline: deadline === null ? null : new Date(deadline).toISOString(),
      possibleCreationDefault: deadline !== null && created !== null && Math.abs(deadline - created) < 5_000,
    });
  }
  return {
    status: issues.some(issue => issue.code !== 'DEADLINE_CONFLICT') ? 'BLOCKED' as const
      : issues.length ? 'REVIEW' as const : 'READY' as const,
    checkedAt: now.toISOString(),
    currentCanonicalField: 'expiryDate',
    checked: records.length,
    expired,
    issues,
  };
}
