/** Custody and independently reviewed procurement receipts; no cost fields. */
export function applyStockReceiptContract(paths, core) {
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const nullableText = { type: ['string', 'null'] };
  const date = { type: 'string', format: 'date-time' };
  const nullableDate = { type: ['string', 'null'], format: 'date-time' };
  const count = { type: 'integer', minimum: 1, maximum: 2147483647 };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const array = items => ({ type: 'array', items });
  const reason = { type: 'string', minLength: 3, maxLength: 4000 };
  const evidence = object({ id, version: count, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, status: { const: 'AVAILABLE' } });
  const physicalProperties = {
    partNumber: id, uom: { type: 'string', minLength: 1, maxLength: 64 }, trackingType: { enum: ['SERIAL', 'BATCH'] }, quantity: count,
    serialNumber: nullableText, batchNumber: nullableText, conditionCode: { type: 'string', minLength: 1, maxLength: 64 },
    certificateReferences: { ...array(object({ id, fileHash: { type: 'string', minLength: 1, maxLength: 512 } })), maxItems: 100 },
    certificateType: nullableText, certificateNumber: nullableText, lifeLimited: { type: 'boolean' },
    remainingHours: { type: ['number', 'null'] }, remainingCycles: { type: ['integer', 'null'] },
    shelfLifeDate: nullableDate, shelfLifeDays: { type: ['integer', 'null'], minimum: 0, maximum: 2147483647 },
    nextOverhaulDue: nullableDate, storageCondition: nullableText,
  };
  core.schemas.StockReceiptPhysical = object(physicalProperties, ['partNumber', 'uom', 'trackingType', 'quantity', 'conditionCode']);
  core.schemas.StockReceiptStorage = object({ location: id, warehouse: id, shelf: nullableText }, ['location', 'warehouse']);
  core.schemas.StockReceiptArrival = object({ purchaseCommitmentId: id, purchaseVersion: count, supplierDeliveryReference: id, reason,
    evidenceIds: { ...array(id), minItems: 1, maxItems: 20, uniqueItems: true },
    lines: { ...array(object({ purchaseCommitmentLineId: id, physical: ref('StockReceiptPhysical'), storage: ref('StockReceiptStorage') })), minItems: 1, maxItems: 100 },
  });
  const checks = object({ identity: { type: 'boolean' }, documents: { type: 'boolean' }, conditionAndLife: { type: 'boolean' }, customerRequirements: { type: 'boolean' } });
  core.schemas.StockReceiptReview = object({ version: count, snapshotHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    decision: { enum: ['ACCEPTED', 'REJECTED'] }, reason, checks });
  const identity = object({ schemaVersion: { const: 1 }, purchaseCommitmentLineId: id, orderLineId: id, quotationLineId: id, rfqLineId: id,
    partNumber: id, uom: { type: 'string' }, serialNumber: nullableText, batchNumber: nullableText,
    conditionCode: { type: 'string' }, trackingType: { enum: ['SERIAL', 'BATCH'] } });
  const snapshot = object({ physical: ref('StockReceiptPhysical'), storage: ref('StockReceiptStorage') });
  core.schemas.StockReceiptLine = object({ id, lineNo: count, purchaseCommitmentLineId: id, quantity: count,
    status: { enum: ['PENDING_REVIEW', 'ACCEPTED', 'REJECTED'] }, version: count, identitySnapshot: identity,
    qualitySnapshot: snapshot, evidence: array(evidence), reviewedById: nullableText, reviewedAt: nullableDate,
    reviewReason: nullableText, inventoryDetailId: nullableText, createdAt: date, updatedAt: date });
  core.schemas.StockReceipt = object({ id, receiptNumber: id, purchaseCommitmentId: id, version: count, receivedById: id,
    receivedAt: date, supplierDeliveryReference: id, reason: nullableText, evidence: array(evidence), createdAt: date, updatedAt: date,
    purchaseCommitment: object({ orderId: id, commitmentNumber: id, supplierId: id }), lines: array(ref('StockReceiptLine')) });
  core.schemas.StockReceiptReviewContext = object({ receiptLineId: id, version: count, status: { enum: ['PENDING_REVIEW', 'ACCEPTED', 'REJECTED'] },
    snapshotHash: { type: 'string' }, snapshot: object({ receiptId: id, receiptLineId: id, version: count, receiptVersion: count,
      identity, physical: snapshot, requirements: { type: 'object', description: 'Server-built current quality facts; no commercial fields.', additionalProperties: true }, evidence: array(evidence) }),
    issues: array(object({ code: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' } })), canAccept: { type: 'boolean' } });
  const configure = (path, method, data, request, status = '200') => {
    const operation = paths[path]?.[method];
    if (!operation) throw new Error(`Receipt route missing: ${method} ${path}`);
    operation['x-aerolink-contract-status'] = 'contracted'; delete operation['x-aerolink-deferred-reason'];
    operation.description = 'Scoped procurement receipt custody and independent quality review. No purchase cost fields are returned.';
    operation.responses = { [status]: { description: 'Receipt command or operational view.',
      content: { 'application/json': { schema: object({ success: { const: true }, data }) } } },
      ...Object.fromEntries([400, 401, 403, 404, 409, 422, 429, 500].map(code => [String(code), { $ref: '#/components/responses/Error' }])) };
    if (request) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: ref(request) } } };
      const header = operation.parameters?.find(p => p.in === 'header' && p.name === 'Idempotency-Key');
      if (!header) throw new Error('Receipt writes need an idempotency header');
      header.required = true;
    } else delete operation.requestBody;
    return operation;
  };
  const list = configure('/api/stock-receipts', 'get', object({ orderId: id, receipts: array(ref('StockReceipt')) }));
  list.parameters = [...(list.parameters ?? []), { name: 'orderId', in: 'query', required: true, schema: id }];
  list['x-aerolink-strict-query'] = true;
  configure('/api/stock-receipts/{id}', 'get', ref('StockReceipt'));
  configure('/api/stock-receipts/lines/{id}/review-context', 'get', ref('StockReceiptReviewContext'));
  configure('/api/stock-receipts', 'post', ref('StockReceipt'), 'StockReceiptArrival', '201');
  configure('/api/stock-receipts/lines/{id}/review', 'post', ref('StockReceipt'), 'StockReceiptReview');
}
