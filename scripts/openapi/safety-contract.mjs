// Contracts for the first internal-use safety increment. Keep these in the
// scaffold source so later regeneration cannot re-enable legacy task sync.
export function applySafetyContract(paths, core) {
  const string = { type: 'string' };
  const quantity = { type: 'integer', minimum: 1 };
  const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
  const envelope = (data) => ({ type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', const: true }, data }, additionalProperties: false });
  const request = {
    orderId: { type: 'string', minLength: 1 }, quantity,
    snapshotHash: { type: 'string', minLength: 64, maxLength: 64 }, approved: { type: 'boolean' },
    evidenceIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
    verifiedSerialNumber: string, verifiedBatchNumber: string,
    checks: {
      type: 'object', required: ['identity', 'documents', 'conditionAndLife', 'customerRequirements'], additionalProperties: false,
      properties: { identity: { type: 'boolean' }, documents: { type: 'boolean' }, conditionAndLife: { type: 'boolean' }, customerRequirements: { type: 'boolean' } },
    },
    reason: { type: 'string', minLength: 3, maxLength: 4000 },
  };
  core.schemas.FulfillmentReviewCreateRequest = { type: 'object', required: Object.keys(request), properties: request, additionalProperties: false };
  core.schemas.FulfillmentReviewResultEnvelope = envelope({ type: 'object', required: ['id', 'approved', 'reviewedAt', 'quantity'], properties: { id: string, approved: { type: 'boolean' }, reviewedAt: { type: 'string', format: 'date-time' }, quantity }, additionalProperties: false });
  core.schemas.FulfillmentReviewPreviewEnvelope = envelope({
    type: 'object', required: ['snapshot', 'snapshotHash', 'review'], additionalProperties: false,
    properties: {
      snapshotHash: string,
      snapshot: {
        type: 'object', required: ['order', 'requirements', 'inventory', 'certificates', 'plannedQuantity'], additionalProperties: false,
        properties: {
          order: { type: 'object', additionalProperties: true, description: 'Current identity, tracking and quality requirements; no cost fields.' },
          requirements: { type: 'object', additionalProperties: true, description: 'Versioned customer and quotation quality requirements.' },
          inventory: { type: 'object', additionalProperties: true, description: 'Physical identity, condition, life and document references; no cost fields.' },
          certificates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          plannedQuantity: quantity,
        },
      },
      review: {
        type: ['object', 'null'], required: ['approved', 'snapshotHash', 'consumedAt', 'reviewedAt', 'quantity'], additionalProperties: false,
        properties: { approved: { type: 'boolean' }, snapshotHash: string, consumedAt: { type: ['string', 'null'], format: 'date-time' }, reviewedAt: { type: 'string', format: 'date-time' }, quantity },
      },
    },
  });
  const configure = (path, method, responseName, status) => {
    const operation = paths[path][method];
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = 'Server-authoritative delivery quality review. Requires quality_review capability. Client identity/time fields are rejected; changes to reviewed facts invalidate approval.';
    operation.responses[status] = { description: 'Quality review response', content: { 'application/json': { schema: schemaRef(responseName) } } };
    if (status !== '200') delete operation.responses['200'];
    return operation;
  };
  const preview = configure('/api/inventory-transactions/quality-review/{orderId}', 'get', 'FulfillmentReviewPreviewEnvelope', '200');
  preview.parameters.push({ name: 'quantity', in: 'query', required: true, schema: quantity });
  const create = configure('/api/inventory-transactions/quality-reviews', 'post', 'FulfillmentReviewResultEnvelope', '201');
  create.requestBody = { required: true, content: { 'application/json': { schema: schemaRef('FulfillmentReviewCreateRequest') } } };
  const sync = paths['/api/agents/runtime/tasks/{id}'].put;
  sync.deprecated = true;
  sync.description = 'Disabled legacy browser task synchronization. Authorized callers receive 410; no task data is written.';
  delete sync.requestBody;
  delete sync.responses['200'];
  sync.responses['410'] = { description: 'Client runtime synchronization is disabled', content: { 'application/json': { schema: schemaRef('ErrorEnvelope') } } };
  for (const name of ['QuotationCreateRequest', 'Quotation']) {
    if (core.schemas[name]?.properties) core.schemas[name].properties.currency = { type: 'string', enum: ['USD'], default: 'USD' };
  }
  core.schemas.Quotation.properties.requiresReapproval = {
    type: 'boolean', readOnly: true,
    description: 'True for an approved quotation whose latest approval does not cover the current policy and commercial terms. An authorised independent approver must review it again.',
  };
  for (const name of ['QuotationCreateRequest', 'OrderCreateRequest', 'OrderUpdateRequest']) {
    if (core.schemas[name]?.properties?.saleType) core.schemas[name].properties.saleType = { type: 'string', enum: ['Sale'] };
  }
}
