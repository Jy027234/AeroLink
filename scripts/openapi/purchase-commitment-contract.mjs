/**
 * Contract for the procurement commitment boundary.
 *
 * Purchase commitments are deliberately line-first.  The request source is a
 * strict discriminated union, and every write carries a required idempotency
 * key because the route executes a Serializable command.  Cost and supplier
 * evidence fields remain optional in responses: purchaseAccess omits them
 * unless the caller has purchase_commitment.view_cost.
 */
export function applyPurchaseCommitmentContract(paths, core) {
  const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
  const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });
  const requestBodyRef = (name) => ({ $ref: `#/components/requestBodies/${name}` });
  const errorResponses = () => Object.fromEntries(
    [400, 401, 403, 404, 409, 422, 429, 500]
      .map((status) => [String(status), { $ref: '#/components/responses/Error' }]),
  );
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const decimal = {
    type: 'string',
    pattern: '^\\d{1,14}(\\.\\d{1,4})?$',
    description: 'Decimal(18,4) money serialized as a string.',
  };
  const dateTime = { type: 'string', format: 'date-time' };
  const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
  const costDescription = 'Omitted unless purchase_commitment.view_cost is granted.';
  const costField = (schema, description = costDescription) => ({
    ...schema,
    description,
    'x-aerolink-capability': 'purchase_commitment.view_cost',
    readOnly: true,
  });

  const supplierQuoteSource = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'supplierQuoteId'],
    properties: {
      type: { const: 'SUPPLIER_QUOTE' },
      supplierQuoteId: id,
    },
  };
  const manualSource = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'unitCost', 'currency', 'reason', 'evidenceFileIds'],
    properties: {
      type: { const: 'MANUAL' },
      unitCost: { ...decimal, description: 'Manual Decimal(18,4) unit cost.' },
      currency: { type: 'string', const: 'USD', enum: ['USD'] },
      reason: { type: 'string', minLength: 3, maxLength: 4000 },
      evidenceFileIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: id },
    },
  };

  core.schemas.PurchaseCommitmentSupplierQuoteSource = supplierQuoteSource;
  core.schemas.PurchaseCommitmentManualSource = manualSource;
  core.schemas.PurchaseCommitmentSource = {
    oneOf: [schemaRef('PurchaseCommitmentSupplierQuoteSource'), schemaRef('PurchaseCommitmentManualSource')],
    discriminator: { propertyName: 'type', mapping: {
      SUPPLIER_QUOTE: '#/components/schemas/PurchaseCommitmentSupplierQuoteSource',
      MANUAL: '#/components/schemas/PurchaseCommitmentManualSource',
    } },
    description: 'Strict source union. Manual cost always requires verified USD and private purchase evidence.',
  };
  core.schemas.PurchaseCommitmentLineCreateRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['orderLineId', 'source', 'quantity', 'promisedDate', 'fulfillmentMode'],
    properties: {
      orderLineId: id,
      source: schemaRef('PurchaseCommitmentSource'),
      quantity: { type: 'integer', minimum: 1, maximum: 2147483647 },
      promisedDate: { ...dateTime, description: 'RFC 3339 date-time including an explicit offset.' },
      fulfillmentMode: { type: 'string', enum: ['STOCK_RECEIPT', 'SUPPLIER_DIRECT'] },
    },
  };
  core.schemas.PurchaseCommitmentCreateRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['orderId', 'supplierId', 'lines'],
    properties: {
      orderId: id,
      supplierId: id,
      paymentTerms: { type: ['string', 'null'], minLength: 1, maxLength: 2000 },
      lines: { type: 'array', minItems: 1, maxItems: 100, items: schemaRef('PurchaseCommitmentLineCreateRequest') },
    },
  };
  core.schemas.PurchaseCommitmentTransitionRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reason'],
    properties: {
      version: { type: 'integer', minimum: 1, maximum: 2147483647 },
      reason: { type: 'string', minLength: 3, maxLength: 4000 },
    },
  };
  core.schemas.PurchaseCommitmentConfirmRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reason', 'supplierReferenceNo', 'evidenceIds'],
    properties: {
      version: { type: 'integer', minimum: 1, maximum: 2147483647 },
      reason: { type: 'string', minLength: 3, maxLength: 4000 },
      supplierReferenceNo: id,
      evidenceIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: id },
    },
  };

  const evidenceFingerprint = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'version', 'sha256', 'status'],
    properties: {
      id,
      version: { type: 'integer', minimum: 1 },
      sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      status: { const: 'AVAILABLE' },
    },
  };
  const approvalSnapshot = {
    type: ['object', 'null'],
    additionalProperties: true,
    description: costDescription,
    'x-aerolink-capability': 'purchase_commitment.view_cost',
    readOnly: true,
  };
  const confirmationEvidence = {
    type: ['array', 'null'],
    items: evidenceFingerprint,
    description: costDescription,
    'x-aerolink-capability': 'purchase_commitment.view_cost',
    readOnly: true,
  };
  const line = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'lineNo', 'orderLineId', 'partNumber', 'uom', 'quantity',
      'cancelledQuantity', 'receivedQuantity', 'directShippedQuantity', 'version',
      'promisedDate', 'fulfillmentMode',
    ],
    properties: {
      id: { ...id, readOnly: true },
      lineNo: { type: 'integer', minimum: 1, readOnly: true },
      orderLineId: { ...id, readOnly: true },
      partNumber: { type: 'string', minLength: 1, readOnly: true },
      uom: { type: 'string', minLength: 1, readOnly: true },
      quantity: { type: 'integer', minimum: 1, readOnly: true },
      cancelledQuantity: { type: 'integer', minimum: 0, readOnly: true },
      receivedQuantity: { type: 'integer', minimum: 0, readOnly: true },
      directShippedQuantity: { type: 'integer', minimum: 0, readOnly: true },
      version: { type: 'integer', minimum: 1, readOnly: true },
      promisedDate: { ...dateTime, readOnly: true },
      fulfillmentMode: { type: 'string', enum: ['STOCK_RECEIPT', 'SUPPLIER_DIRECT'], readOnly: true },
      currency: costField({ type: 'string', const: 'USD' }),
      unitCost: costField(decimal),
      lineTotal: costField(decimal),
      sourceSupplierQuoteId: costField({ type: ['string', 'null'] }),
      sourceSnapshot: costField({ type: ['object', 'null'], additionalProperties: true }),
    },
  };
  core.schemas.PurchaseCommitmentLine = line;
  core.schemas.PurchaseCommitment = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'commitmentNumber', 'orderId', 'supplierId', 'supplierName', 'status',
      'version', 'createdAt', 'submittedAt', 'approvedAt', 'confirmedAt', 'lines',
    ],
    properties: {
      id: { ...id, readOnly: true },
      commitmentNumber: { type: 'string', minLength: 1, readOnly: true },
      orderId: { ...id, readOnly: true },
      supplierId: { ...id, readOnly: true },
      supplierName: { type: 'string', minLength: 1, readOnly: true },
      status: { type: 'string', enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED', 'REJECTED', 'CANCELLED'], readOnly: true },
      version: { type: 'integer', minimum: 1, readOnly: true },
      createdAt: { ...dateTime, readOnly: true },
      submittedAt: { ...nullableDateTime, readOnly: true },
      approvedAt: { ...nullableDateTime, readOnly: true },
      confirmedAt: { ...nullableDateTime, readOnly: true },
      currency: costField({ type: 'string', const: 'USD' }),
      totalCost: costField(decimal),
      paymentTerms: costField({ type: ['string', 'null'] }),
      supplierReferenceNo: costField({ type: ['string', 'null'] }),
      approvalLevel: costField({ type: ['string', 'null'] }),
      approvalPolicyVersion: costField({ type: ['string', 'null'] }),
      approvalSnapshot,
      confirmationEvidence,
      lines: { type: 'array', items: schemaRef('PurchaseCommitmentLine'), readOnly: true },
    },
  };
  core.schemas.PurchaseCommitmentOrderList = {
    type: 'object',
    additionalProperties: false,
    required: ['orderId', 'purchases'],
    properties: {
      orderId: { ...id, readOnly: true },
      purchases: { type: 'array', items: schemaRef('PurchaseCommitment'), readOnly: true },
    },
  };

  const envelope = (data) => ({
    type: 'object',
    additionalProperties: true,
    required: ['success', 'data'],
    properties: { success: { const: true }, data },
  });
  core.schemas.PurchaseCommitmentEnvelope = envelope(schemaRef('PurchaseCommitment'));
  core.schemas.PurchaseCommitmentOrderListEnvelope = envelope(schemaRef('PurchaseCommitmentOrderList'));
  core.requestBodies.PurchaseCommitmentCreate = {
    required: true,
    content: { 'application/json': { schema: schemaRef('PurchaseCommitmentCreateRequest') } },
  };
  core.requestBodies.PurchaseCommitmentTransition = {
    required: true,
    content: { 'application/json': { schema: schemaRef('PurchaseCommitmentTransitionRequest') } },
  };
  core.requestBodies.PurchaseCommitmentConfirm = {
    required: true,
    content: { 'application/json': { schema: schemaRef('PurchaseCommitmentConfirmRequest') } },
  };
  core.responses.PurchaseCommitment = {
    description: 'Procurement commitment response; cost and supplier evidence are omitted without purchase_commitment.view_cost.',
    content: { 'application/json': { schema: schemaRef('PurchaseCommitmentEnvelope') } },
  };
  core.responses.PurchaseCommitmentOrderList = {
    description: 'Procurement commitments for an order; cost and supplier evidence are omitted without purchase_commitment.view_cost.',
    content: { 'application/json': { schema: schemaRef('PurchaseCommitmentOrderListEnvelope') } },
  };

  const configure = (routePath, method, responseName, status, description, requestBodyName) => {
    const operation = paths[routePath]?.[method];
    if (!operation) throw new Error(`Purchase commitment route missing from catalog: ${method.toUpperCase()} ${routePath}`);
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = description;
    operation.responses = { [status]: responseRef(responseName), ...errorResponses() };
    if (requestBodyName) operation.requestBody = requestBodyRef(requestBodyName);
    else delete operation.requestBody;
    return operation;
  };
  const requireIdempotencyKey = (operation) => {
    const header = operation.parameters?.find((parameter) => parameter.in === 'header' && parameter.name === 'Idempotency-Key');
    if (!header) throw new Error('Purchase commitment write is missing Idempotency-Key parameter');
    header.required = true;
    header.description = 'Required stable key for retry-safe procurement commands.';
    header.schema = { type: 'string', minLength: 1, maxLength: 255 };
  };

  const orderList = configure(
    '/api/purchase-commitments', 'get', 'PurchaseCommitmentOrderList', '200',
    'Lists purchase commitments for a modern order. orderId is the only accepted query parameter; cost and supplier evidence follow purchase_commitment.view_cost.',
  );
  orderList.parameters = [
    ...(orderList.parameters ?? []),
    { name: 'orderId', in: 'query', required: true, schema: id },
  ];
  orderList['x-aerolink-strict-query'] = true;
  configure(
    '/api/purchase-commitments/{id}', 'get', 'PurchaseCommitment', '200',
    'Returns one purchase commitment with cost fields only when purchase_commitment.view_cost is granted.',
  );
  const create = configure(
    '/api/purchase-commitments', 'post', 'PurchaseCommitment', '201',
    'Creates a strict line-first purchase commitment from a supplier quote or private manual-cost evidence.',
    'PurchaseCommitmentCreate',
  );
  requireIdempotencyKey(create);
  const transitionSpecs = [
    ['submit', 'PurchaseCommitmentTransition', 'Submits a purchase commitment for approval.'],
    ['approve', 'PurchaseCommitmentTransition', 'Approves a purchase commitment after current source and coverage checks.'],
    ['reject', 'PurchaseCommitmentTransition', 'Rejects a purchase commitment with a required reason.'],
    ['confirm', 'PurchaseCommitmentConfirm', 'Confirms supplier reference and private confirmation evidence.'],
    ['cancel', 'PurchaseCommitmentTransition', 'Cancels a purchase commitment under its version check.'],
  ];
  for (const [action, request, description] of transitionSpecs) {
    const operation = configure(
      `/api/purchase-commitments/{id}/${action}`, 'post', 'PurchaseCommitment', '200', description, request,
    );
    requireIdempotencyKey(operation);
  }
}
