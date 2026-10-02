function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function objectSchema(properties, required = []) {
  return { type: 'object', required, properties, additionalProperties: false };
}

function idSchema() {
  return { type: 'string', minLength: 1 };
}

function dateSchema() {
  return { type: 'string', format: 'date' };
}

function dateTimeSchema() {
  return { type: 'string', format: 'date-time' };
}

function moneyStringSchema(description) {
  return {
    type: 'string',
    pattern: '^-?\\d+(?:\\.\\d+)?$',
    ...(description ? { description } : {}),
  };
}

function costSourceChoices() {
  return [
    {
      properties: {
        costSourceType: { const: 'MANUAL' },
        costSourceId: false,
        costSourceReason: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      required: ['costSourceType', 'costSourceReason'],
    },
    {
      properties: {
        costSourceType: { enum: ['SUPPLIER_QUOTE', 'INVENTORY_DETAIL'] },
        costSourceId: { type: 'string', minLength: 1 },
      },
      required: ['costSourceType', 'costSourceId'],
    },
  ];
}

/**
 * The line contract is deliberately kept in the scaffold source. The
 * generated OpenAPI document is checked in, so regeneration must preserve the
 * distinction between legacy scalar requests and server-owned line facts.
 */
export function applyTransactionLineContract(paths, core) {
  const str = { type: 'string' };
  const id = idSchema();
  const nullable = { type: ['string', 'null'] };
  const date = dateSchema();
  const dateTime = dateTimeSchema();
  const stringArray = { type: 'array', items: str };
  const alternatePartNumbers = { oneOf: [stringArray, { type: 'string' }] };
  const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });

  // RFQ response and line projection. Decimal target prices are serialized as
  // strings so the response keeps precision across JSON clients.
  core.schemas.RfqLine = objectSchema({
    id,
    rfqId: id,
    lineNo: { type: 'integer', minimum: 1 },
    partNumber: str,
    quantity: { type: 'integer', minimum: 1 },
    uom: str,
    conditionCode: str,
    description: nullable,
    serialNumber: nullable,
    batchNumber: nullable,
    ataChapter: nullable,
    aircraftType: nullable,
    aircraftModel: nullable,
    alternatePartNumbers: stringArray,
    certificateRequired: { type: 'boolean' },
    certificateType: nullable,
    requiredDate: date,
    leadTimeDays: { type: ['integer', 'null'] },
    targetPriceDecimal: nullable,
    targetPriceCurrency: str,
    status: { type: 'string', enum: ['OPEN', 'COMPLETED', 'CANCELLED'] },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'rfqId', 'lineNo', 'partNumber', 'quantity', 'uom', 'conditionCode', 'requiredDate', 'certificateRequired', 'targetPriceCurrency', 'status', 'createdAt', 'updatedAt']);
  core.schemas.Rfq.properties.lineItemsMode = {
    type: 'boolean',
    readOnly: true,
    description: 'True when the RFQ contains more than one authoritative demand line.',
  };
  core.schemas.Rfq.properties.lines = {
    type: 'array',
    readOnly: true,
    description: 'Authoritative demand lines ordered by lineNo.',
    items: schemaRef('RfqLine'),
  };

  const lineFields = {
    partNumber: { type: 'string', minLength: 1 },
    quantity: { type: 'integer', minimum: 1 },
    uom: { type: 'string', minLength: 1, maxLength: 32, default: 'EA' },
    conditionCode: { type: 'string', minLength: 1, maxLength: 32, default: 'NE' },
    description: { type: 'string' },
    serialNumber: { type: 'string' },
    batchNumber: { type: 'string' },
    ataChapter: { type: 'string' },
    aircraftType: { type: 'string' },
    aircraftModel: { type: 'string' },
    alternatePartNumbers,
    targetPrice: { type: 'number', minimum: 0 },
    targetPriceCurrency: { type: 'string', minLength: 1, maxLength: 8, default: 'USD' },
    certificateRequired: { type: 'boolean', default: true },
    certificateType: { type: 'string' },
    requiredDate: date,
    leadTimeDays: { type: 'integer', minimum: 0 },
  };
  core.schemas.RfqLineCreateRequest = objectSchema(lineFields, ['partNumber', 'quantity', 'requiredDate']);
  core.schemas.RfqLineUpdateRequest = objectSchema({ id, ...lineFields }, ['partNumber', 'quantity', 'requiredDate']);

  // Preserve scalar request schemas under explicit names. The public request
  // names below become oneOf unions; each branch is strict so a stale header
  // fact cannot accompany modern line facts.
  const legacyRfqCreate = clone(core.schemas.RfqCreateRequest);
  delete legacyRfqCreate.properties.lines;
  core.schemas.RfqLegacyCreateRequest = legacyRfqCreate;
  const legacyRfqUpdate = clone(core.schemas.RfqUpdateRequest);
  delete legacyRfqUpdate.properties.lines;
  core.schemas.RfqLegacyUpdateRequest = legacyRfqUpdate;

  const rfqContext = {
    customerId: id,
    responseDeadline: date,
    urgency: { type: 'string', enum: ['AOG', 'URGENT', 'STANDARD'], default: 'STANDARD' },
    urgencyJustification: { type: 'string' },
    notes: { type: 'string' },
    emailId: id,
  };
  core.schemas.RfqMultiLineCreateRequest = objectSchema({
    ...rfqContext,
    lines: { type: 'array', minItems: 1, maxItems: 100, items: schemaRef('RfqLineCreateRequest') },
  }, ['customerId', 'lines']);
  core.schemas.RfqMultiLineUpdateRequest = objectSchema({
    ...rfqContext,
    lines: { type: 'array', minItems: 1, maxItems: 100, items: schemaRef('RfqLineUpdateRequest') },
  }, ['lines']);
  core.schemas.RfqCreateRequest = {
    oneOf: [schemaRef('RfqLegacyCreateRequest'), schemaRef('RfqMultiLineCreateRequest')],
    description: 'Legacy scalar RFQ creation or strict modern multi-line creation. Demand header fields cannot be mixed with lines.',
  };
  core.schemas.RfqUpdateRequest = {
    oneOf: [schemaRef('RfqLegacyUpdateRequest'), schemaRef('RfqMultiLineUpdateRequest')],
    description: 'Legacy scalar RFQ patch or a complete strict line collection. Demand header fields cannot be mixed with lines.',
  };

  // Quotation lines are returned in lineNo order. Monetary Decimal values are
  // strings; sensitive cost fields remain optional because the server omits
  // them for callers without quotation.view_cost.
  core.schemas.QuotationLine = objectSchema({
    id,
    quotationId: id,
    lineNo: { type: 'integer', minimum: 1 },
    rfqLineId: id,
    sourceSupplierQuoteId: { type: ['string', 'null'], readOnly: true },
    partNumber: str,
    description: nullable,
    uom: str,
    quantity: { type: 'integer', minimum: 1 },
    unitPrice: moneyStringSchema('Decimal unit price serialized as a string.'),
    costPrice: { ...moneyStringSchema('Omitted unless quotation.view_cost is granted.'), readOnly: true },
    lineTotal: moneyStringSchema('Decimal line total serialized as a string.'),
    marginAmount: { ...moneyStringSchema('Omitted unless quotation.view_cost is granted.'), readOnly: true },
    marginPercent: { ...moneyStringSchema('Omitted unless quotation.view_cost is granted.'), readOnly: true },
    currency: str,
    costSourceType: { type: ['string', 'null'], enum: ['SUPPLIER_QUOTE', 'INVENTORY_DETAIL', 'MANUAL', null], readOnly: true },
    costSourceId: { type: ['string', 'null'], readOnly: true },
    costSourceReason: { type: ['string', 'null'], readOnly: true },
    costSourceSnapshotJson: { type: ['string', 'null'], readOnly: true, description: 'Omitted unless quotation.view_cost is granted.' },
    costSourceCapturedAt: { type: ['string', 'null'], format: 'date-time', readOnly: true },
    acceptedQuantity: { type: 'integer', minimum: 0 },
    reservedQuantity: { type: 'integer', minimum: 0 },
    inventoryDetailId: { type: ['string', 'null'] },
    serialNumber: nullable,
    batchNumber: nullable,
    status: str,
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'quotationId', 'lineNo', 'rfqLineId', 'partNumber', 'uom', 'quantity', 'unitPrice', 'lineTotal', 'currency', 'acceptedQuantity', 'reservedQuantity', 'status', 'createdAt', 'updatedAt']);
  core.schemas.OrderLine = objectSchema({
    id,
    orderId: id,
    lineNo: { type: 'integer', minimum: 1 },
    quotationLineId: id,
    partNumber: str,
    uom: str,
    quantity: { type: 'integer', minimum: 1 },
    unitPrice: moneyStringSchema('Decimal unit price serialized as a string.'),
    lineTotal: moneyStringSchema('Decimal line total serialized as a string.'),
    currency: str,
    outboundQuantity: { type: 'integer', minimum: 0 },
    directShippedQuantity: { type: 'integer', minimum: 0, readOnly: true },
    outboundStatus: str,
    inventoryDetailId: { type: ['string', 'null'] },
    serialNumber: nullable,
    batchNumber: nullable,
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'orderId', 'lineNo', 'quotationLineId', 'partNumber', 'uom', 'quantity', 'unitPrice', 'lineTotal', 'currency', 'outboundQuantity', 'outboundStatus', 'createdAt', 'updatedAt']);
  core.schemas.Quotation.properties.lineItemsMode = {
    type: 'boolean',
    readOnly: true,
    description: 'True when quotation line facts are authoritative.',
  };
  core.schemas.Quotation.properties.lines = {
    type: 'array',
    readOnly: true,
    description: 'Authoritative quotation lines ordered by lineNo; sensitive cost fields follow quotation.view_cost.',
    items: schemaRef('QuotationLine'),
  };
  core.schemas.Order.properties.lineItemsMode = {
    type: 'boolean',
    readOnly: true,
    description: 'True when order line facts are authoritative.',
  };
  core.schemas.Order.properties.directShippedQuantity = { type: 'integer', minimum: 0, readOnly: true };
  core.schemas.Order.properties.lines = {
    type: 'array',
    readOnly: true,
    description: 'Authoritative order lines ordered by lineNo.',
    items: schemaRef('OrderLine'),
  };

  const legacyQuotationCreate = clone(core.schemas.QuotationCreateRequest);
  delete legacyQuotationCreate.properties.lines;
  core.schemas.QuotationLegacyCreateRequest = legacyQuotationCreate;

  const quotationLineFields = {
    rfqLineId: id,
    partNumber: { type: 'string', minLength: 1 },
    quantity: { type: 'integer', minimum: 1 },
    unitPrice: { type: 'number', minimum: 0 },
    costPrice: { type: 'number', minimum: 0 },
    costSourceType: { type: 'string', enum: ['SUPPLIER_QUOTE', 'INVENTORY_DETAIL', 'MANUAL'] },
    costSourceId: { type: 'string', minLength: 1 },
    costSourceReason: { type: 'string', maxLength: 1000 },
  };
  core.schemas.QuotationLineCreateRequest = {
    ...objectSchema(quotationLineFields, ['rfqLineId', 'partNumber', 'quantity', 'unitPrice', 'costPrice', 'costSourceType']),
    allOf: [{ oneOf: costSourceChoices() }],
  };

  const modernQuotationProperties = clone(legacyQuotationCreate.properties);
  for (const field of ['partNumber', 'quantity', 'unitPrice', 'costPrice', 'costSourceType', 'costSourceId', 'costSourceReason']) delete modernQuotationProperties[field];
  modernQuotationProperties.currency = { type: 'string', enum: ['USD'], const: 'USD', default: 'USD' };
  modernQuotationProperties.saleType = { type: 'string', enum: ['Sale'], default: 'Sale' };
  modernQuotationProperties.lines = { type: 'array', minItems: 1, maxItems: 100, items: schemaRef('QuotationLineCreateRequest') };
  core.schemas.QuotationMultiLineCreateRequest = objectSchema(modernQuotationProperties, ['rfqId', 'customerId', 'currency', 'lines']);
  core.schemas.QuotationCreateRequest = {
    oneOf: [schemaRef('QuotationLegacyCreateRequest'), schemaRef('QuotationMultiLineCreateRequest')],
    description: 'Legacy scalar quotation or strict USD modern multi-line quotation. Commercial demand and cost facts live on lines in modern mode.',
  };

  // Modern acceptance must carry a version and explicit line quantities. The
  // legacy branch remains unchanged for scalar quotations.
  core.schemas.QuotationAcceptanceLine = objectSchema({
    quotationLineId: id,
    quantity: { type: 'integer', minimum: 1 },
  }, ['quotationLineId', 'quantity']);
  const acceptanceLines = { type: 'array', minItems: 1, maxItems: 100, items: schemaRef('QuotationAcceptanceLine') };
  core.schemas.QuotationAcceptRequest.properties.lines = acceptanceLines;
  core.schemas.QuotationAcceptRequest.allOf = [{
    oneOf: [
      { properties: { lines: false } },
      { required: ['version', 'lines'], properties: { version: { type: 'integer', minimum: 1 }, lines: acceptanceLines } },
    ],
  }];
  core.schemas.QuotationAcceptRequest.description = 'Legacy acceptance remains scalar. Modern quotation acceptance requires an optimistic-lock version and explicit line quantities.';

  const inquiry = core.schemas.Inquiry.properties;
  inquiry.rfqId = nullable;
  inquiry.notes = nullable;
  inquiry.sourceVerified = { type: 'boolean', readOnly: true };
  const item = inquiry.items.items.properties;
  Object.assign(item, { id: str, lineNo: { type: 'integer', minimum: 1 }, rfqLineId: nullable });
  const create = core.schemas.InquiryCreateRequest.properties;
  create.notes = { type: 'string', maxLength: 4000 };
  create.lineIds = { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1 } };
  create.supplierIds.maxItems = 50;
  const createOperation = paths['/api/inquiries'].post;
  createOperation.description = 'Creates source-linked inquiry drafts in one idempotent transaction. No supplier message is sent. Current RFQ access is required, including on replay.';
  createOperation.parameters ??= [];
  if (!createOperation.parameters.some(parameter => parameter.name === 'Idempotency-Key')) createOperation.parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: str });
  const send = paths['/api/inquiries/{id}/send'].post;
  delete send.deprecated;
  send.description = 'Queues one supplier inquiry email through the transactional outbox. A 202 response means queued, not delivered. SMTP acceptance is not confirmation that the supplier received or read the message. Inquiry delivery errors with an uncertain outcome require manual verification and are not safely replayable.';
  send.parameters ??= [];
  if (!send.parameters.some(parameter => parameter.name === 'Idempotency-Key')) send.parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: str });

  const cancelSend = paths['/api/inquiries/{id}/cancel-send'].post;
  cancelSend.description = 'Cancels a queued inquiry only when its EMAIL Outbox event is still PENDING with attemptCount 0 and no worker lease. A conditional update races safely with worker claiming. SMTP-started, retrying, failed, or otherwise uncertain deliveries cannot be cancelled or replayed here and require manual verification. The original outbound email snapshot is retained.';
  cancelSend.requestBody = undefined;
  cancelSend.responses = {
    '200': { $ref: '#/components/responses/Inquiry' },
    '403': { $ref: '#/components/responses/Error' },
    '404': { $ref: '#/components/responses/Error' },
    '409': { $ref: '#/components/responses/Error' },
  };

  inquiry.deliveryStatus = {
    type: 'string',
    enum: ['draft', 'queued', 'processing', 'retrying', 'smtp_accepted', 'needs_verification', 'failed', 'cancelled', 'skipped'],
    readOnly: true,
    description: 'SMTP acceptance is not proof of supplier delivery or reading. needs_verification means replay is unsafe until a person checks the delivery outcome.',
  };
  const latestEmail = inquiry.latestOutboundEmail.oneOf[0];
  latestEmail.properties.status.enum = ['pending', 'sending', 'sent', 'failed', 'needs_verification', 'withdrawn'];
  Object.assign(latestEmail.properties, {
    outboxStatus: { type: ['string', 'null'], enum: ['pending', 'processing', 'retrying', 'delivered', 'failed', 'cancelled', null], readOnly: true },
    attemptCount: { type: ['integer', 'null'], minimum: 0, readOnly: true },
    canCancel: { type: 'boolean', readOnly: true, description: 'True only before any Worker claim or SMTP attempt.' },
    manualVerificationRequired: { type: 'boolean', readOnly: true },
    manualVerificationMessage: { type: ['string', 'null'], readOnly: true },
  });
  latestEmail.required.push('outboxStatus', 'attemptCount', 'canCancel', 'manualVerificationRequired', 'manualVerificationMessage');
}
