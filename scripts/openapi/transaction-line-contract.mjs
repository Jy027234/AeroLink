export function applyTransactionLineContract(paths, core) {
  const str = { type: 'string' };
  const nullable = { type: ['string', 'null'] };
  core.schemas.RfqLine = {
    type: 'object', additionalProperties: false,
    required: ['id', 'rfqId', 'lineNo', 'partNumber', 'quantity', 'uom', 'conditionCode', 'requiredDate', 'certificateRequired', 'targetPriceCurrency', 'status', 'createdAt', 'updatedAt'],
    properties: {
      id: str, rfqId: str, lineNo: { type: 'integer', minimum: 1 }, partNumber: str,
      quantity: { type: 'integer', minimum: 1 }, uom: str, conditionCode: str,
      description: nullable, serialNumber: nullable, batchNumber: nullable,
      alternatePartNumbers: { type: 'array', items: str }, certificateRequired: { type: 'boolean' }, certificateType: nullable,
      requiredDate: { type: 'string', format: 'date' }, leadTimeDays: { type: ['integer', 'null'] },
      targetPriceDecimal: nullable, targetPriceCurrency: str, status: { type: 'string', enum: ['OPEN', 'COMPLETED', 'CANCELLED'] },
      createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
    },
  };
  core.schemas.Rfq.properties.lines = { type: 'array', readOnly: true, items: { $ref: '#/components/schemas/RfqLine' } };
  for (const name of ['RfqCreateRequest', 'RfqUpdateRequest', 'QuotationCreateRequest', 'OrderCreateRequest']) {
    if (core.schemas[name]?.properties) core.schemas[name].properties.lines = false;
  }
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
  send.deprecated = true;
  send.description = 'No dispatch channel is implemented. Returns 409 MANUAL_WORKFLOW_REQUIRED without changing status or sentAt.';
  delete send.responses['200'];
  send.responses['409'] = { description: 'Manual supplier contact required; inquiry has not been sent.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } };
}
