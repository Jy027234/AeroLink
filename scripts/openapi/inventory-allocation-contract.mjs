/** Explicit quantity commands and public, cost-free allocation projections. */
export function applyInventoryAllocationContract(paths, core) {
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  const id = { type: 'string', minLength: 1 };
  const count = { type: 'integer', minimum: 0, maximum: 2147483647 };
  const quantity = { ...count, minimum: 1 };
  for (const name of ['Inventory', 'InventoryDetail']) {
    core.schemas[name].properties.allocatedQuantity = { ...count, readOnly: true };
  }
  core.schemas.Inventory.properties.availableQuantity = { ...count, readOnly: true };
  const text = { type: 'string' };
  const date = { type: 'string', format: 'date-time' };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const array = items => ({ type: 'array', items });
  core.schemas.InventoryItemSafePatch = object({ partNumber: { ...text, minLength: 1 }, description: { ...text, minLength: 1 },
    partCategory: { ...text, minLength: 1 }, trackingType: { ...text, minLength: 1 }, unitOfMeasure: { ...text, minLength: 1 },
    ...Object.fromEntries(['manufacturer', 'manufacturerCageCode', 'ataChapter', 'alternatePartNumbers', 'countryOfOrigin', 'hsCode']
      .map(name => [name, { type: ['string', 'null'] }])) }, []);
  paths['/api/inventory-items/{id}'].patch.requestBody = { required: true,
    content: { 'application/json': { schema: ref('InventoryItemSafePatch') } } };
  const slices = (key) => ({ ...array(object({ [key]: id, quantity })), minItems: 1, maxItems: 100 });
  const assignment = object({ id, orderLineId: id, assignedQuantity: count, releasedQuantity: count, consumedQuantity: count, activeQuantity: count });
  core.schemas.InventoryAllocationAssignment = assignment;
  core.schemas.InventoryAllocation = object({ id, quotationLineId: id, inventoryDetailId: id,
    stockReceiptLineId: { type: ['string', 'null'] }, sourceReturnHoldId: { type: ['string', 'null'] },
    allocatedQuantity: count, releasedQuantity: count, consumedQuantity: count, activeQuantity: count,
    unassignedQuantity: count, assignedActiveQuantity: count, expiresAt: { ...date, type: ['string', 'null'] },
    assignments: array(ref('InventoryAllocationAssignment')) });
  core.schemas.QuotationLineAllocationView = object({ quotationLineId: id, quantity: count, acceptedQuantity: count,
    reservedQuantity: count, unassignedQuantity: count, assignedActiveQuantity: count, activeQuantity: count,
    allocations: array(ref('InventoryAllocation')) });
  core.schemas.OrderLineAllocationView = object({ id, quotationLineId: id, quantity: count, outboundQuantity: count,
    assignments: array(object({ ...assignment.properties, allocationId: id, inventoryDetailId: id })) });
  core.schemas.InventoryAllocationReserve = object({ quotationLineId: id, orderLineId: id, allocations: {
    ...array({ ...object({ inventoryDetailId: id, quantity, stockReceiptLineId: id, sourceReturnHoldId: id }, ['inventoryDetailId', 'quantity']),
      not: { properties: { stockReceiptLineId: id, sourceReturnHoldId: id }, required: ['stockReceiptLineId', 'sourceReturnHoldId'] } }), minItems: 1, maxItems: 100,
  } }, ['quotationLineId', 'allocations']);
  core.schemas.InventoryAllocationAssign = object({ orderLineId: id, allocations: slices('allocationId') });
  core.schemas.InventoryAllocationRelease = object({ allocationId: id, assignmentId: id, quantity,
    reason: { ...text, minLength: 1, maxLength: 1000 } }, ['allocationId', 'quantity', 'reason']);
  core.schemas.InventoryAllocationCommandResult = object({ commandId: id, replayed: { type: 'boolean' }, quotationLineId: id,
    orderLineId: { type: ['string', 'null'] }, allocationId: id, assignmentId: { type: ['string', 'null'] }, releasedQuantity: count, reason: text,
    createdAllocationIds: array(id), createdAssignmentIds: array(id), allocations: array(ref('InventoryAllocation')) },
  ['commandId', 'replayed', 'quotationLineId', 'allocations']);
  const checks = object({ identity: { type: 'boolean' }, documents: { type: 'boolean' }, conditionAndLife: { type: 'boolean' }, customerRequirements: { type: 'boolean' } });
  core.schemas.AllocationQualityReviewCreate = object({ assignmentId: id, quantity, snapshotHash: { ...text, pattern: '^[a-fA-F0-9]{64}$' },
    approved: { type: 'boolean' }, evidenceIds: { ...array(id), maxItems: 20 }, verifiedSerialNumber: text, verifiedBatchNumber: text,
    certificateIdentity: object({ id, certificateId: id, certificateNumber: text, certificateType: text, partNumber: text,
      serialNumber: { type: ['string', 'null'] }, batchNumber: { type: ['string', 'null'] }, fileHash: { type: ['string', 'null'] } }, []),
    checks, reason: { ...text, minLength: 3, maxLength: 4000 } },
  ['assignmentId', 'quantity', 'snapshotHash', 'approved', 'evidenceIds', 'verifiedSerialNumber', 'verifiedBatchNumber', 'checks', 'reason']);
  core.schemas.AllocationQualityReviewCreated = object({ id, approved: { type: 'boolean' }, reviewedAt: date, quantity });
  // This snapshot has an explicit public allowlist in the service. Nested
  // evidence evolves independently, while its identity and planned quantity remain fixed.
  core.schemas.AllocationQualityPreview = object({ snapshotHash: { ...text, minLength: 64, maxLength: 64 },
    snapshot: { type: 'object', required: ['schemaVersion', 'assignment', 'allocation', 'orderLine', 'inventory', 'plannedQuantity'],
      properties: { schemaVersion: { const: 1 }, assignment: { type: 'object' }, allocation: { type: 'object' },
        orderLine: { type: 'object' }, inventory: { type: 'object' }, plannedQuantity: quantity }, additionalProperties: true },
    review: { anyOf: [{ type: 'null' }, object({ id, approved: { type: 'boolean' }, snapshotHash: text,
      consumedAt: { ...date, type: ['string', 'null'] }, reviewedAt: date, quantity })] } });
  core.schemas.InventoryAllocationConsume = object({ assignmentId: id, quantity, reviewId: id, notes: { ...text, maxLength: 4000 } }, ['assignmentId', 'quantity', 'reviewId']);
  core.schemas.InventoryAllocationConsumed = object({ assignmentId: id, allocationId: id, inventoryDetailId: id,
    quantity, beforeQuantity: count, afterQuantity: count, transactionId: id, orderId: id, orderStatus: text,
    allocationVersion: quantity, assignmentVersion: quantity });
  core.schemas.QuotationAcceptanceLine.properties.allocations = slices('allocationId');
  const configure = (path, method, responseSchema, requestSchema, status = '200') => {
    const operation = paths[`/api/inventory-allocations/${path}`]?.[method];
    if (!operation) throw new Error(`Missing allocation route: ${path}`);
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = 'Current object permissions are checked. Quantity projections contain no commercial cost fields. Mutations use serializable transactions and persistent command identities.';
    operation.responses = { [status]: { description: 'Allocation operation result', content: { 'application/json': {
      schema: object({ success: { const: true }, data: ref(responseSchema) }) } } },
      ...Object.fromEntries([400, 401, 403, 404, 409, 422, 429, 500].map(code => [code, { $ref: '#/components/responses/Error' }])) };
    if (requestSchema) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: ref(requestSchema) } } };
      operation.parameters = (operation.parameters ?? []).filter(parameter => parameter.name !== 'Idempotency-Key');
      operation.parameters.push({ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } });
    } else delete operation.requestBody;
    return operation;
  };
  configure('reserve', 'post', 'InventoryAllocationCommandResult', 'InventoryAllocationReserve', '201');
  configure('assign', 'post', 'InventoryAllocationCommandResult', 'InventoryAllocationAssign', '201');
  configure('release', 'post', 'InventoryAllocationCommandResult', 'InventoryAllocationRelease');
  configure('consume', 'post', 'InventoryAllocationConsumed', 'InventoryAllocationConsume');
  configure('quotation-lines/{quotationLineId}', 'get', 'QuotationLineAllocationView');
  configure('order-lines/{orderLineId}', 'get', 'OrderLineAllocationView');
  const preview = configure('quality-review/{assignmentId}', 'get', 'AllocationQualityPreview');
  preview.parameters.push({ in: 'query', name: 'quantity', required: true, schema: quantity });
  configure('quality-reviews', 'post', 'AllocationQualityReviewCreated', 'AllocationQualityReviewCreate', '201');
}
