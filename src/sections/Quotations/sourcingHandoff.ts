export interface SourcingQuoteHandoff {
  rfqId: string;
  rfqLineId: string;
  supplierQuoteId: string;
}

export function parseSourcingQuoteHandoff(search: string): SourcingQuoteHandoff | null {
  const params = new URLSearchParams(search);
  const rfqId = params.get('rfqId')?.trim();
  const rfqLineId = params.get('rfqLineId')?.trim();
  const supplierQuoteId = params.get('supplierQuoteId')?.trim();
  return rfqId && rfqLineId && supplierQuoteId ? { rfqId, rfqLineId, supplierQuoteId } : null;
}
