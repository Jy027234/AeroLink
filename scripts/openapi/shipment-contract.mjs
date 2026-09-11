/**
 * Contract for modern order shipments, receipts, and return holds.
 *
 * The service deliberately exposes identity, quantity, quality evidence, and
 * state only.  Command/request hashes, event internals, and commercial cost
 * fields are not part of these DTOs.
 */
export function applyShipmentContract(paths, core) {
  const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
  const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });
  const requestBodyRef = (name) => ({ $ref: `#/components/requestBodies/${name}` });

  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const count = { type: 'integer', minimum: 0, maximum: 2147483647 };
  const quantity = { type: 'integer', minimum: 1, maximum: 2147483647 };
  const version = { type: 'integer', minimum: 1, maximum: 2147483647 };
  const dateTime = { type: 'string', format: 'date-time' };
  const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
  const text = { type: 'string' };
  const nullableText = { type: ['string', 'null'] };
  const array = (items, bounds = {}) => ({ type: 'array', items, ...bounds });
  const object = (properties, required = Object.keys(properties)) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
  const envelope = (data) => object({ success: { const: true }, data });
  const errors = () => Object.fromEntries(
    [400, 401, 403, 404, 409, 422, 429, 500]
      .map((status) => [String(status), { $ref: '#/components/responses/Error' }]),
  );

  const evidence = object({
    id,
    version,
    sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    status: { type: 'string', minLength: 1 },
  });
  core.schemas.ShipmentEvidence = evidence;

  // All identity snapshots are explicitly allowlisted.  They contain no
  // price, cost, customer, or command data and are shared by shipment lines
  // and return quality snapshots.
  const identity = object({
    inventoryDetailId: id,
    inventoryItemId: id,
    partNumber: { type: 'string', minLength: 1 },
    trackingType: { type: 'string', minLength: 1 },
    serialNumber: nullableText,
    batchNumber: nullableText,
    conditionCode: { type: 'string', minLength: 1 },
    warehouse: nullableText,
    location: nullableText,
  });
  core.schemas.ShipmentIdentitySnapshot = identity;

  const certificate = object({
    id,
    certificateNumber: nullableText,
    partNumber: nullableText,
    serialNumber: nullableText,
    batchNumber: nullableText,
    certificateType: nullableText,
    status: nullableText,
    expiryDate: nullableDateTime,
    fileHash: nullableText,
    updatedAt: nullableDateTime,
  });
  core.schemas.ShipmentCertificate = certificate;

  const reviewEvidence = object({
    outboundTransactionId: id,
    reviewId: id,
    snapshotHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    evidence: array(schemaRef('ShipmentEvidence')),
    certificates: array(schemaRef('ShipmentCertificate')),
  });
  core.schemas.ShipmentQualityEvidence = reviewEvidence;
  core.schemas.ShipmentEvidenceBundle = object({
    qualityReviews: array(schemaRef('ShipmentQualityEvidence')),
    attachments: array(schemaRef('ShipmentEvidence')),
  });

  const returnHold = object({
    id,
    shipmentLineId: id,
    inventoryDetailId: id,
    quantity,
    status: { type: 'string', minLength: 1 },
    version,
    snapshotHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    receivedById: id,
    receivedAt: dateTime,
    releasedById: { type: ['string', 'null'], minLength: 1 },
    releasedAt: nullableDateTime,
    identitySnapshot: schemaRef('ShipmentIdentitySnapshot'),
    evidence: array(schemaRef('ShipmentEvidence')),
    releaseReason: nullableText,
    returnTransactionId: { type: ['string', 'null'], minLength: 1 },
  }, ['id', 'shipmentLineId', 'inventoryDetailId', 'quantity', 'status', 'version', 'snapshotHash',
    'receivedById', 'receivedAt', 'releasedById', 'releasedAt', 'identitySnapshot', 'evidence']);
  core.schemas.ShipmentReturnHold = returnHold;

  const shipmentLine = object({
    id,
    lineNo: { type: 'integer', minimum: 1, maximum: 2147483647 },
    orderLineId: id,
    assignmentId: id,
    outboundTransactionId: id,
    quantity,
    receivedQuantity: count,
    returnedQuantity: count,
    version,
    identitySnapshot: schemaRef('ShipmentIdentitySnapshot'),
    returns: array(schemaRef('ShipmentReturnHold')),
  });
  core.schemas.ShipmentLine = shipmentLine;

  const shipment = object({
    id,
    shipmentNumber: { type: 'string', minLength: 1 },
    carrier: { type: 'string', minLength: 1 },
    trackingNumber: { type: 'string', minLength: 1 },
    origin: { type: 'string', minLength: 1 },
    destination: { type: 'string', minLength: 1 },
    status: { type: 'string', minLength: 1 },
    version,
    shippedAt: nullableDateTime,
    evidence: schemaRef('ShipmentEvidenceBundle'),
    lines: array(schemaRef('ShipmentLine')),
  });
  core.schemas.Shipment = shipment;

  const outboundTransaction = object({
    id,
    orderLineId: { type: ['string', 'null'], minLength: 1 },
    assignmentId: { type: ['string', 'null'], minLength: 1 },
    inventoryDetailId: id,
    inventoryItemId: id,
    partNumber: { type: 'string', minLength: 1 },
    trackingType: { type: 'string', minLength: 1 },
    serialNumber: nullableText,
    batchNumber: nullableText,
    conditionCode: { type: 'string', minLength: 1 },
    warehouse: nullableText,
    location: nullableText,
    quantity: count,
    boundQuantity: count,
    availableQuantity: {
      ...count,
      description: 'Remaining quantity that can be bound to a shipment. It is 0 when the source lacks a current assignment or consumed quality review.',
    },
    requiresHistoricalReview: {
      type: 'boolean',
      description: 'True when the source has no current assignment/review mapping and must not be silently treated as shippable.',
    },
  });
  core.schemas.ShipmentOutboundTransaction = outboundTransaction;

  const deliveryLine = object({
    orderLineId: id,
    quantity: count,
    receivedQuantity: count,
    remainingQuantity: count,
    fullyReceived: { type: 'boolean' },
  });
  core.schemas.ShipmentDeliveryLine = deliveryLine;
  core.schemas.ShipmentDelivery = object({
    requiredQuantity: count,
    receivedQuantity: count,
    remainingQuantity: count,
    complete: { type: 'boolean' },
    lines: array(schemaRef('ShipmentDeliveryLine')),
  });

  core.schemas.ShipmentOrder = object({
    order: object({ id, status: { type: 'string', minLength: 1 }, version }),
    outboundTransactions: array(schemaRef('ShipmentOutboundTransaction')),
    shipments: array(schemaRef('Shipment')),
    delivery: schemaRef('ShipmentDelivery'),
  });

  // Return-release snapshots intentionally include only identity, quality,
  // certificate, and evidence facts.  They do not expose inventory unit cost
  // or any quotation/order commercial projection.
  const qualitySnapshot = object({
    status: nullableText,
    quantity: count,
    allocatedQuantity: count,
    conditionCode: nullableText,
    certificateType: nullableText,
    certificateNumber: nullableText,
    certificateFileUrl: nullableText,
    lifeLimited: { type: 'boolean' },
    remainingHours: { type: ['number', 'null'] },
    remainingCycles: { type: ['number', 'null'] },
    shelfLifeDate: nullableDateTime,
    shelfLifeDays: { type: ['number', 'null'] },
    nextOverhaulDue: nullableDateTime,
    storageCondition: nullableText,
    updatedAt: nullableDateTime,
    itemUpdatedAt: nullableDateTime,
    certificates: array(schemaRef('ShipmentCertificate')),
  });
  core.schemas.ShipmentReturnSnapshot = object({
    schemaVersion: { const: 1 },
    shipmentLineId: id,
    inventoryDetailId: id,
    assignmentId: { type: ['string', 'null'], minLength: 1 },
    outboundTransactionId: id,
    quantity,
    identitySnapshot: schemaRef('ShipmentIdentitySnapshot'),
    quality: qualitySnapshot,
    evidence: array(schemaRef('ShipmentEvidence')),
  });
  const returnContextLine = object({
    id,
    shipmentId: id,
    orderLineId: id,
    assignmentId: id,
    outboundTransactionId: id,
    quantity,
    receivedQuantity: count,
    returnedQuantity: count,
    version,
    identitySnapshot: schemaRef('ShipmentIdentitySnapshot'),
  });
  const returnContextDetail = object({
    id,
    inventoryItemId: id,
    partNumber: { type: 'string', minLength: 1 },
    trackingType: { type: 'string', minLength: 1 },
    serialNumber: nullableText,
    batchNumber: nullableText,
    conditionCode: nullableText,
    warehouse: nullableText,
    location: nullableText,
    status: { type: 'string', minLength: 1 },
    quantity: count,
    allocatedQuantity: count,
    certificateType: nullableText,
    certificateNumber: nullableText,
    lifeLimited: { type: 'boolean' },
    remainingHours: { type: ['number', 'null'] },
    remainingCycles: { type: ['number', 'null'] },
    shelfLifeDate: nullableDateTime,
    nextOverhaulDue: nullableDateTime,
  });
  // The current release context is a safe hold projection plus the freshly
  // recomputed review snapshot.  Required fields mirror returnService's
  // publicContext; internal command/request hashes are intentionally absent.
  core.schemas.ShipmentReturnReleaseContext = object({
    id,
    shipmentLineId: id,
    inventoryDetailId: id,
    quantity,
    status: { type: 'string', minLength: 1 },
    version,
    identitySnapshot: schemaRef('ShipmentIdentitySnapshot'),
    evidence: array(schemaRef('ShipmentEvidence')),
    snapshotHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    receivedById: id,
    receivedAt: dateTime,
    releasedById: { type: ['string', 'null'], minLength: 1 },
    releasedAt: nullableDateTime,
    releaseReason: nullableText,
    returnTransactionId: { type: ['string', 'null'], minLength: 1 },
    returnHoldId: id,
    receivedSnapshotHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    snapshot: schemaRef('ShipmentReturnSnapshot'),
    shipmentLine: returnContextLine,
    inventoryDetail: returnContextDetail,
    certificates: array(schemaRef('ShipmentCertificate')),
    currentSnapshotHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
  }, ['id', 'shipmentLineId', 'inventoryDetailId', 'quantity', 'status', 'version', 'identitySnapshot',
    'evidence', 'snapshotHash', 'receivedById', 'receivedAt', 'releasedById', 'releasedAt',
    'returnHoldId', 'receivedSnapshotHash', 'snapshot', 'shipmentLine', 'inventoryDetail',
    'certificates', 'currentSnapshotHash']);

  const returnCommandResult = object({
    ...returnHold.properties,
    replayed: { type: 'boolean' },
  }, [...returnHold.required, 'replayed']);
  core.schemas.ShipmentReturnCommandResult = returnCommandResult;

  const lineSource = object({ outboundTransactionId: id, quantity });
  core.schemas.ShipmentCreateRequest = object({
    orderId: id,
    carrier: { type: 'string', minLength: 1, maxLength: 300 },
    trackingNumber: { type: 'string', minLength: 1, maxLength: 300 },
    origin: { type: 'string', minLength: 1, maxLength: 300 },
    destination: { type: 'string', minLength: 1, maxLength: 300 },
    lines: array(lineSource, { minItems: 1, maxItems: 100 }),
    // Zod defaults this to [] when omitted.  It remains optional on input.
    evidenceIds: array(id, { maxItems: 20 }),
  }, ['orderId', 'carrier', 'trackingNumber', 'origin', 'destination', 'lines']);
  core.schemas.ShipmentReceiptRequest = object({
    lines: array(object({ shipmentLineId: id, quantity }), { minItems: 1, maxItems: 100 }),
    evidenceIds: array(id, { minItems: 1, maxItems: 20 }),
    reason: { type: 'string', minLength: 3, maxLength: 4000 },
  });
  core.schemas.ShipmentReturnRequest = object({
    shipmentLineId: id,
    quantity,
    evidenceIds: array(id, { minItems: 1, maxItems: 20 }),
    verifiedSerialNumber: { type: 'string', maxLength: 200 },
    verifiedBatchNumber: { type: 'string', maxLength: 200 },
    reason: { type: 'string', minLength: 3, maxLength: 4000 },
  });
  core.schemas.ShipmentReturnReleaseRequest = object({
    snapshotHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    evidenceIds: array(id, { minItems: 1, maxItems: 20 }),
    verifiedSerialNumber: { type: 'string', maxLength: 200 },
    verifiedBatchNumber: { type: 'string', maxLength: 200 },
    checks: object({
      identity: { type: 'boolean' },
      documents: { type: 'boolean' },
      conditionAndLife: { type: 'boolean' },
      customerRequirements: { type: 'boolean' },
    }),
    reason: { type: 'string', minLength: 3, maxLength: 4000 },
  });

  core.requestBodies.ShipmentCreate = {
    required: true,
    content: { 'application/json': { schema: schemaRef('ShipmentCreateRequest') } },
  };
  core.requestBodies.ShipmentReceipt = {
    required: true,
    content: { 'application/json': { schema: schemaRef('ShipmentReceiptRequest') } },
  };
  core.requestBodies.ShipmentReturn = {
    required: true,
    content: { 'application/json': { schema: schemaRef('ShipmentReturnRequest') } },
  };
  core.requestBodies.ShipmentReturnRelease = {
    required: true,
    content: { 'application/json': { schema: schemaRef('ShipmentReturnReleaseRequest') } },
  };

  core.responses.ShipmentOrder = {
    description: 'Modern order shipment view; quantity, identity, delivery, and safe quality evidence only.',
    content: { 'application/json': { schema: envelope(schemaRef('ShipmentOrder')) } },
  };
  core.responses.Shipment = {
    description: 'Created or updated shipment safe view.',
    content: { 'application/json': { schema: envelope(schemaRef('Shipment')) } },
  };
  core.responses.ShipmentReturnHold = {
    description: 'Quarantined or released return hold safe view.',
    content: { 'application/json': { schema: envelope(schemaRef('ShipmentReturnCommandResult')) } },
  };
  core.responses.ShipmentReturnReleaseContext = {
    description: 'Current return quality-release snapshot without commercial cost fields.',
    content: { 'application/json': { schema: envelope(schemaRef('ShipmentReturnReleaseContext')) } },
  };

  const configure = (routePath, method, responseName, status, description, requestBodyName) => {
    const operation = paths[routePath]?.[method];
    if (!operation) throw new Error(`Shipment route missing from catalog: ${method.toUpperCase()} ${routePath}`);
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = description;
    operation.responses = { [status]: responseRef(responseName), ...errors() };
    operation.parameters = (operation.parameters ?? []).filter((parameter) => parameter.name !== 'Idempotency-Key');
    if (requestBodyName) {
      operation.requestBody = requestBodyRef(requestBodyName);
      operation.parameters.push({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
        description: 'Stable command identity required for retry-safe shipment, receipt, return, and release writes.',
        schema: { type: 'string', minLength: 1, maxLength: 255 },
      });
    } else {
      operation.requestBody = undefined;
    }
    return operation;
  };

  const orderReadDescription = 'Reads the current modern order shipment view under order.read and current order owner/department scope. QUALITY_MANAGER may use this order view without quotation.read. Outbound sources expose no costs; a source missing current assignment or quality-review mapping has availableQuantity 0 and requiresHistoricalReview=true.';
  configure('/api/shipments/orders/{orderId}', 'get', 'ShipmentOrder', '200', orderReadDescription);
  configure('/api/shipments/returns/{id}/release-context', 'get', 'ShipmentReturnReleaseContext', '200', 'Reads the current return identity, quality, certificate, and evidence snapshot under quality_review.approve and current order scope. QUALITY_MANAGER does not need quotation.read; the snapshot contains no commercial cost fields.');
  configure('/api/shipments', 'post', 'Shipment', '201', 'Creates a modern shipment from explicitly selected OUTBOUND transaction sources under inventory.manage and current order scope. No source is selected implicitly; each source must have a current assignment and consumed quality review.', 'ShipmentCreate');
  configure('/api/shipments/dispatches/{id}/receipts', 'post', 'Shipment', '200', 'Records explicit receipt quantities for shipment lines under inventory.manage and current order scope. Evidence must be supplied by the authenticated operator and the response contains safe quantity/state projections only.', 'ShipmentReceipt');
  configure('/api/shipments/returns', 'post', 'ShipmentReturnHold', '201', 'Creates a quarantined return hold under inventory.manage and current order scope. The hold is identity/evidence scoped and does not silently increase saleable inventory.', 'ShipmentReturn');
  configure('/api/shipments/returns/{id}/release', 'post', 'ShipmentReturnHold', '200', 'Releases a return hold only after an independent quality_review.approve decision and current snapshot/evidence checks under the order scope. The response is a safe hold projection without command internals or cost fields.', 'ShipmentReturnRelease');
}
