/**
 * Header-to-line status projections shared by the runtime lifecycle and the
 * historical backfill. Every value returned here is accepted by the D10 line
 * table checks; unknown legacy spellings remain an active/open projection
 * until a business transition records a known terminal state.
 */
export function rfqLineStatus(status: string) {
  const normalized = String(status || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
  if (['CANCELLED', 'CANCELED', 'LOST'].includes(normalized)) return 'CANCELLED';
  if (['COMPLETED', 'WON'].includes(normalized)) return 'COMPLETED';
  return 'OPEN';
}

export function quotationLineStatus(status: string, acceptedQuantity: number, quantity: number) {
  const normalized = String(status || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
  if (normalized === 'ACCEPTED' || normalized === 'ORDERED' || normalized === 'COMPLETED') {
    return acceptedQuantity > 0 && acceptedQuantity < quantity ? 'PARTIALLY_ACCEPTED' : 'ACCEPTED';
  }
  if (normalized === 'SENT' || normalized === 'APPROVED') return 'APPROVED';
  if (normalized === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
  if (normalized === 'REJECTED') return 'REJECTED';
  if (normalized === 'WITHDRAWN' || normalized === 'EXPIRED') return 'CANCELLED';
  return 'DRAFT';
}
