export function applyCommercialCostContract(core) {
  const sourceType = { type: 'string', enum: ['SUPPLIER_QUOTE', 'INVENTORY_DETAIL', 'MANUAL'] };
  const sourceFields = {
    costSourceType: sourceType,
    costSourceId: { type: 'string', minLength: 1 },
    costSourceReason: { type: 'string', maxLength: 1000 },
  };
  const choices = [
    { properties: { costSourceType: { const: 'MANUAL' }, costSourceId: false, costSourceReason: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['costSourceType', 'costSourceReason'] },
    { properties: { costSourceType: { enum: ['SUPPLIER_QUOTE', 'INVENTORY_DETAIL'] }, costSourceId: { type: 'string', minLength: 1 } }, required: ['costSourceType', 'costSourceId'] },
  ];
  // QuotationCreateRequest is a strict legacy/modern union. Cost-source
  // fields belong to the legacy scalar branch here; modern quotations carry
  // the same proof on each QuotationLineCreateRequest instead.
  const create = core.schemas.QuotationLegacyCreateRequest ?? core.schemas.QuotationCreateRequest;
  if (!create?.properties) throw new Error('Quotation legacy create schema must expose properties before applying cost contract');
  Object.assign(create.properties, sourceFields);
  create.required = [...new Set([...(create.required ?? []), 'costSourceType'])];
  create.allOf = [{ oneOf: choices }];
  create.description = 'USD sale quotation with an explicit, verifiable cost source. Supplier or inventory source identity, quantity and price are validated server-side; manual cost requires a reason.';
  const approve = core.schemas.QuotationApproveRequest;
  Object.assign(approve.properties, sourceFields);
  approve.allOf = [{ oneOf: [
    { not: { required: ['costSourceType'], properties: { costSourceType: sourceType } }, properties: { costSourceId: false, costSourceReason: false } },
    ...choices,
  ] }];
  approve.description = 'Independent approval under the current amount policy. Explicit cost source fields allow historical missing evidence to be captured and approved in one version-checked transaction.';
  const quote = core.schemas.Quotation.properties;
  Object.assign(quote, {
    costSourceType: { ...sourceType, type: ['string', 'null'], enum: [...sourceType.enum, null], readOnly: true },
    costSourceId: { type: ['string', 'null'], readOnly: true },
    costSourceReason: { type: ['string', 'null'], readOnly: true },
    costSourceSnapshotJson: { type: ['string', 'null'], readOnly: true, description: 'Immutable cost evidence, omitted without quotation.view_cost.' },
    costSourceCapturedAt: { type: ['string', 'null'], format: 'date-time', readOnly: true },
  });
  // Existing read-only records may retain another currency; inputs are USD-only.
  quote.currency = { type: 'string' };
  for (const name of ['SupplierQuoteCreateRequest', 'SupplierQuoteUpdateRequest']) {
    core.schemas[name].properties.currency = { type: 'string', enum: ['USD'], ...(name === 'SupplierQuoteCreateRequest' ? { default: 'USD' } : {}) };
    for (const field of ['rfqId', 'rfqLineId', 'inquiryId', 'inquiryItemId']) {
      core.schemas[name].properties[field] = { type: 'string', minLength: 1 };
    }
  }
  Object.assign(core.schemas.SupplierQuoteUpdateRequest.properties, {
    partNumber: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1 },
  });
  core.schemas.SupplierQuoteCreateRequest.description = 'USD supplier quote with exact source IDs. A unique RFQ line may be selected from the specified RFQ; multi-line RFQs require an explicit line ID. Inquiry ownership and supplier identity are verified in the same transaction.';
  core.schemas.SupplierQuoteUpdateRequest.description = 'Updates commercial availability without rewriting captured quotation cost snapshots. Source identity changes require a new supplier quote; sending the unchanged IDs is allowed.';
  for (const name of ['SupplierQuote', 'SupplierQuoteDetail']) {
    Object.assign(core.schemas[name].properties, {
      currency: { type: ['string', 'null'], description: 'Historical missing currency remains null.' },
      currencyStatus: { type: 'string', enum: ['VERIFIED', 'HISTORICAL_UNVERIFIED'], readOnly: true },
      rfqLineId: { type: ['string', 'null'], readOnly: true },
      inquiryItemId: { type: ['string', 'null'], readOnly: true },
    });
  }
}
