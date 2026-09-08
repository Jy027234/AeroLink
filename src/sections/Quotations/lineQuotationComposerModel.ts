import type { RfqLine } from '@/types';
import type { LineQuotationDraft } from './LineQuotationComposer';

const OPEN_LINE_STATUSES = new Set<RfqLine['status']>(['OPEN']);

export function createLineQuotationDraft(line: RfqLine): LineQuotationDraft {
  return {
    rfqLineId: line.id,
    partNumber: line.partNumber,
    quantity: line.quantity,
    unitPrice: 0,
    costPrice: 0,
    costSourceType: 'MANUAL',
    costSourceId: '',
    costSourceReason: '',
  };
}

/** Build a stable, RFQ-order draft for all or a selected subset of open lines. */
export function createLineQuotationDrafts(
  rfq: { lines?: RfqLine[] },
  selectedLineIds?: string[],
): LineQuotationDraft[] {
  const selected = selectedLineIds ? new Set(selectedLineIds) : null;
  return (rfq.lines ?? [])
    .filter(line => OPEN_LINE_STATUSES.has(line.status))
    .filter(line => !selected || selected.has(line.id))
    .map(createLineQuotationDraft);
}
