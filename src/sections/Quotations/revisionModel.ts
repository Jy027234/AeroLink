import type { QuotationRevisionCreateInput, QuotationRevisionInput } from '@/api/client';
import type { Quotation, QuotationLine } from '@/types';

export interface RevisionIdentity {
  rfqId: string;
  customerId: string;
  lineItemsMode: boolean;
}

export function validateRevisionIdentity(
  source: Pick<Quotation, 'rfqId' | 'customerId' | 'lineItemsMode'>,
  draft: RevisionIdentity,
): 'rfq' | 'customer' | 'mode' | null {
  if (source.rfqId !== draft.rfqId) return 'rfq';
  if (source.customerId !== draft.customerId) return 'customer';
  if ((source.lineItemsMode === true) !== draft.lineItemsMode) return 'mode';
  return null;
}

export function buildQuotationRevisionInput(
  source: Pick<Quotation, 'version'>,
  reason: string,
  quotation: QuotationRevisionCreateInput,
): QuotationRevisionInput {
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error('Revision reason is required');
  return {
    version: source.version,
    reason: normalizedReason,
    quotation,
  };
}

export function remainingRevisionQuantity(line: Pick<QuotationLine, 'quantity' | 'acceptedQuantity'>): number {
  return Math.max(0, line.quantity - Math.max(0, line.acceptedQuantity || 0));
}
