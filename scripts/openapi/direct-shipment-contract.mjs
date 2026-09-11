/** Contract for supplier-direct shipment planning, quality review, dispatch and receipt. */
export function applyDirectShipmentContract(paths, core) {
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const text = { type: 'string', minLength: 1, maxLength: 200 };
  const nullableText = { type: ['string', 'null'] };
  const date = { type: 'string', format: 'date-time' };
  const nullableDate = { type: ['string', 'null'], format: 'date-time' };
  const count = { type: 'integer', minimum: 0, maximum: 2147483647 };
  const quantity = { type: 'integer', minimum: 1, maximum: 2147483647 };
  const version = { type: 'integer', minimum: 1, maximum: 2147483647 };
  const reason = { type: 'string', minLength: 3, maxLength: 4000 };
  const array = (items, bounds = {}) => ({ type: 'array', items, ...bounds });
  const object = (properties, required = Object.keys(properties)) => ({
    type: 'object', properties, required, additionalProperties: false,
  });
  const nullableId = { type: ['string', 'null'], minLength: 1, maxLength: 200 };
  const hash64 = { type: 'string', pattern: '^[a-fA-F0-9]{64}$' };
  const uniqueEvidenceIds = (minimum = 0) => array(id, {
    ...(minimum ? { minItems: minimum } : {}), maxItems: 20, uniqueItems: true,
  });

  const evidence = object({
    id,
    version,
    sha256: hash64,
    status: { const: 'AVAILABLE' },
  });
  core.schemas.DirectShipmentEvidence = evidence;

  const checks = object({
    identity: { type: 'boolean' },
    documents: { type: 'boolean' },
    conditionAndLife: { type: 'boolean' },
    customerRequirements: { type: 'boolean' },
  });
  core.schemas.DirectShipmentChecks = checks;
  const nullableChecks = { ...checks, type: ['object', 'null'] };

  // Direct shipment quality snapshots are built server-side from the same
  // physical/RFQ chain as stock receipt reviews.  Keep the public contract
  // allowlisted so supplier cost/source fields cannot appear through JSON.
  const identity = object({
    schemaVersion: { const: 1 },
    orderLineId: id,
    quotationLineId: id,
    rfqLineId: id,
    partNumber: id,
    uom: text,
    conditionCode: text,
    serialNumber: nullableText,
    batchNumber: nullableText,
    certificateRequired: { type: 'boolean' },
    certificateType: nullableText,
    trackingType: { enum: ['SERIAL', 'BATCH'] },
  }, ['schemaVersion', 'orderLineId', 'quotationLineId', 'rfqLineId', 'partNumber', 'uom', 'conditionCode',
    'serialNumber', 'batchNumber', 'certificateRequired', 'certificateType']);

  const certificate = object({
    id,
    certificateNumber: text,
    partNumber: text,
    serialNumber: nullableText,
    batchNumber: nullableText,
    certificateType: text,
    status: text,
    expiryDate: nullableDate,
    fileHash: nullableText,
    supplierId: nullableId,
    orderId: nullableId,
    inventoryDetailId: nullableId,
    updatedAt: date,
  });
  core.schemas.DirectShipmentCertificate = certificate;

  const chainOrder = object({
    id,
    quotationId: id,
    lineItemsMode: { type: 'boolean' },
    currency: { type: 'string', minLength: 1, maxLength: 16 },
    saleType: nullableText,
    certificateRequired: { type: 'boolean' },
    certificateType: nullableText,
    inspectionRequired: { type: 'boolean' },
  }, ['id', 'quotationId', 'lineItemsMode', 'currency', 'certificateRequired', 'certificateType', 'inspectionRequired']);
  const chainOrderLine = object({
    id,
    orderId: id,
    quotationLineId: id,
    partNumber: text,
    uom: text,
    quantity,
    serialNumber: nullableText,
    batchNumber: nullableText,
    currency: { type: 'string', minLength: 1, maxLength: 16 },
  });
  const chainQuotation = object({ id, rfqId: id, currency: { type: 'string', minLength: 1, maxLength: 16 } });
  const chainQuotationLine = object({
    id,
    quotationId: id,
    rfqLineId: id,
    partNumber: text,
    uom: text,
    quantity,
    serialNumber: nullableText,
    batchNumber: nullableText,
    currency: { type: 'string', minLength: 1, maxLength: 16 },
  });
  const chainRfqLine = object({
    id,
    rfqId: id,
    partNumber: text,
    uom: text,
    quantity,
    conditionCode: text,
    serialNumber: nullableText,
    batchNumber: nullableText,
    certificateRequired: { type: 'boolean' },
    certificateType: nullableText,
    alternatePartNumbers: nullableText,
  }, ['id', 'rfqId', 'partNumber', 'uom', 'quantity', 'conditionCode', 'serialNumber', 'batchNumber',
    'certificateRequired', 'certificateType']);
  const chainRfq = object({ id, lineItemsMode: { type: 'boolean' } }, ['id']);
  const chain = object({
    order: chainOrder,
    orderLine: chainOrderLine,
    quotation: chainQuotation,
    quotationLine: chainQuotationLine,
    rfqLine: chainRfqLine,
    rfq: chainRfq,
  }, ['order', 'orderLine', 'quotation', 'quotationLine', 'rfqLine']);
  const purchase = object({
    purchaseCommitmentId: id,
    purchaseCommitmentLineId: id,
    orderId: id,
    supplierId: id,
    orderLineId: id,
    partNumber: text,
    uom: text,
    quantity,
    fulfillmentMode: { const: 'SUPPLIER_DIRECT' },
    identitySnapshot: identity,
  });
  core.schemas.DirectShipmentQualitySnapshot = object({
    schemaVersion: { const: 1 },
    chain,
    purchase,
    physical: ref('StockReceiptPhysical'),
    certificates: array(ref('DirectShipmentCertificate')),
  });

  core.schemas.DirectShipmentCreateRequest = object({
    purchaseCommitmentId: id,
    purchaseVersion: version,
    carrier: text,
    trackingNumber: text,
    origin: text,
    destination: text,
    reason,
    evidenceIds: uniqueEvidenceIds(1),
    lines: array(object({ purchaseCommitmentLineId: id, physical: ref('StockReceiptPhysical') }), { minItems: 1, maxItems: 100 }),
  });
  core.schemas.DirectShipmentReviewRequest = object({
    version,
    snapshotHash: hash64,
    decision: { enum: ['APPROVED', 'REJECTED'] },
    reason,
    checks,
    evidenceIds: uniqueEvidenceIds(),
  }, ['version', 'snapshotHash', 'decision', 'reason', 'checks']);
  core.schemas.DirectShipmentActionRequest = object({ version, reason });
  core.schemas.DirectShipmentReceiptRequest = object({
    version,
    quantity,
    signedBy: text,
    signedAt: date,
    reason,
    evidenceIds: uniqueEvidenceIds(1),
  });

  const line = object({
    id,
    lineNo: version,
    purchaseCommitmentLineId: id,
    quantity,
    physicalSnapshot: ref('StockReceiptPhysical'),
    reviewStatus: { enum: ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] },
    reviewedById: nullableId,
    reviewedAt: nullableDate,
    reviewReason: nullableText,
    checks: nullableChecks,
    reviewEvidence: array(ref('DirectShipmentEvidence')),
    receivedQuantity: count,
    version,
    createdAt: date,
    updatedAt: date,
  });
  core.schemas.DirectShipmentLine = line;

  const shipment = object({
    id,
    shipmentNumber: text,
    purchaseCommitmentId: id,
    orderId: id,
    carrier: text,
    trackingNumber: text,
    origin: text,
    destination: text,
    reason,
    evidence: array(ref('DirectShipmentEvidence')),
    status: { enum: ['PREPARED', 'CANCELLED', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED'] },
    version,
    createdById: id,
    createdAt: date,
    updatedAt: date,
    dispatchedById: nullableId,
    dispatchedAt: nullableDate,
    cancelledById: nullableId,
    cancelledAt: nullableDate,
    cancellationReason: nullableText,
    lines: array(ref('DirectShipmentLine')),
  });
  core.schemas.DirectShipment = shipment;
  core.schemas.DirectShipmentList = object({ orderId: id, shipments: array(ref('DirectShipment')) });

  const reviewSnapshot = object({
    quality: ref('DirectShipmentQualitySnapshot'),
    evidence: array(ref('DirectShipmentEvidence')),
  });
  core.schemas.DirectShipmentReviewContext = object({
    shipmentLineId: id,
    shipmentId: id,
    version,
    reviewStatus: { enum: ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] },
    snapshot: reviewSnapshot,
    snapshotHash: hash64,
    issues: array(object({ code: text, path: text, message: text })),
    canApprove: { type: 'boolean' },
  });

  const errors = () => Object.fromEntries(
    [400, 401, 403, 404, 409, 422, 429, 500]
      .map(status => [String(status), { $ref: '#/components/responses/Error' }]),
  );
  const responseRef = name => ({ $ref: `#/components/responses/${name}` });
  const requestBodyRef = name => ({ $ref: `#/components/requestBodies/${name}` });
  const envelope = data => object({ success: { const: true }, data });

  core.requestBodies.DirectShipmentCreate = {
    required: true,
    content: { 'application/json': { schema: ref('DirectShipmentCreateRequest') } },
  };
  core.requestBodies.DirectShipmentReview = {
    required: true,
    content: { 'application/json': { schema: ref('DirectShipmentReviewRequest') } },
  };
  core.requestBodies.DirectShipmentAction = {
    required: true,
    content: { 'application/json': { schema: ref('DirectShipmentActionRequest') } },
  };
  core.requestBodies.DirectShipmentReceipt = {
    required: true,
    content: { 'application/json': { schema: ref('DirectShipmentReceiptRequest') } },
  };
  core.responses.DirectShipment = {
    description: 'Safe supplier-direct shipment projection without commercial cost/source fields.',
    content: { 'application/json': { schema: envelope(ref('DirectShipment')) } },
  };
  core.responses.DirectShipmentList = {
    description: 'Safe supplier-direct shipment list scoped to one order.',
    content: { 'application/json': { schema: envelope(ref('DirectShipmentList')) } },
  };
  core.responses.DirectShipmentReviewContext = {
    description: 'Current direct-shipment quality facts and review snapshot without commercial cost/source fields.',
    content: { 'application/json': { schema: envelope(ref('DirectShipmentReviewContext')) } },
  };

  const configure = (path, method, responseName, status, description, requestName) => {
    const operation = paths[path]?.[method];
    if (!operation) throw new Error(`Direct shipment route missing from catalog: ${method.toUpperCase()} ${path}`);
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = description;
    operation.responses = { [status]: responseRef(responseName), ...errors() };
    operation.parameters = (operation.parameters ?? []).filter(parameter => parameter.name !== 'Idempotency-Key');
    if (requestName) {
      operation.requestBody = requestBodyRef(requestName);
      operation.parameters.push({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
        description: 'Stable command identity required for retry-safe direct-shipment writes.',
        schema: { type: 'string', minLength: 1, maxLength: 255 },
      });
    } else {
      operation.requestBody = undefined;
    }
    return operation;
  };

  const list = configure('/api/direct-shipments', 'get', 'DirectShipmentList', '200',
    'Reads supplier-direct shipment projections under inventory.read and current order scope. No commercial cost/source fields are returned.');
  list.parameters = [...(list.parameters ?? []), { name: 'orderId', in: 'query', required: true, schema: id }];
  list['x-aerolink-strict-query'] = true;
  configure('/api/direct-shipments/{id}', 'get', 'DirectShipment', '200',
    'Reads one supplier-direct shipment under inventory.read and current order scope.');
  configure('/api/direct-shipments/lines/{id}/review-context', 'get', 'DirectShipmentReviewContext', '200',
    'Reads current supplier-direct quality facts under quality_review.approve and current order scope.');
  configure('/api/direct-shipments', 'post', 'DirectShipment', '201',
    'Creates a supplier-direct shipment plan from explicit purchase lines and physical facts. Cost/source fields are not accepted or returned.', 'DirectShipmentCreate');
  configure('/api/direct-shipments/lines/{id}/review', 'post', 'DirectShipment', '200',
    'Records an independent supplier-direct quality decision with current evidence and snapshot checks.', 'DirectShipmentReview');
  configure('/api/direct-shipments/{id}/dispatch', 'post', 'DirectShipment', '200',
    'Dispatches an independently approved supplier-direct shipment under current order scope.', 'DirectShipmentAction');
  configure('/api/direct-shipments/{id}/cancel', 'post', 'DirectShipment', '200',
    'Cancels an un-dispatched supplier-direct shipment plan under current order scope.', 'DirectShipmentAction');
  configure('/api/direct-shipments/lines/{id}/receipt', 'post', 'DirectShipment', '200',
    'Records an explicit customer receipt quantity and evidence for a supplier-direct shipment line.', 'DirectShipmentReceipt');
}
