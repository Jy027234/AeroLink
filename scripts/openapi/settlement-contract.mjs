/**
 * Contract for the first settlement boundary.
 *
 * Settlement accounts are USD-only projections of a sales order (AR) and an
 * optional confirmed purchase commitment (AP).  AP and its source snapshot
 * are withheld unless settlement.view_cost is granted; the route filters the
 * list before projecting the response.  Records are append-only external
 * voucher facts and every write uses a version CAS plus a required
 * Idempotency-Key.
 */
export function applySettlementContract(paths, core) {
  const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
  const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });
  const requestBodyRef = (name) => ({ $ref: `#/components/requestBodies/${name}` });
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });
  const reason = { type: 'string', minLength: 3, maxLength: 4000 };
  const dateTime = { type: 'string', format: 'date-time' };
  const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
  const version = { type: 'integer', minimum: 1, maximum: 2147483647 };
  const amount = {
    type: 'string',
    pattern: '^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,4})?$',
    description: 'USD Decimal(18,4) serialized as a plain decimal string.',
  };
  const positiveAmount = {
    ...amount,
    pattern: '^(?!0(?:\\.0{1,4})?$)(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,4})?$',
    description: 'Positive USD Decimal(18,4) serialized as a plain decimal string.',
  };
  const evidenceIds = {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
    items: id,
  };
  const evidence = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'version', 'sha256', 'status'],
    properties: {
      id,
      version,
      sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      // Historical records preserve the original fingerprint even if the
      // stored object is later revoked.
      status: { const: 'AVAILABLE' },
    },
  };
  const sourceSnapshotBase = {
    type: 'object',
    additionalProperties: false,
    required: ['sourceId', 'sourceNumber', 'sourceVersion', 'counterpartyId', 'counterpartyName', 'initialAmount', 'currency'],
    properties: {
      sourceId: id,
      sourceNumber: text(200),
      sourceVersion: version,
      counterpartyId: id,
      counterpartyName: text(300),
      initialAmount: amount,
      currency: { const: 'USD', enum: ['USD'] },
    },
  };
  core.schemas.SettlementReceivableSourceSnapshot = {
    ...sourceSnapshotBase,
    required: ['kind', ...sourceSnapshotBase.required],
    properties: { kind: { const: 'ORDER' }, ...sourceSnapshotBase.properties },
  };
  core.schemas.SettlementPayableSourceSnapshot = {
    ...sourceSnapshotBase,
    required: ['kind', ...sourceSnapshotBase.required],
    properties: { kind: { const: 'PURCHASE' }, ...sourceSnapshotBase.properties },
    description: 'Private payable source snapshot. Omitted unless settlement.view_cost is granted.',
    'x-aerolink-capability': 'settlement.view_cost',
  };

  const record = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'kind', 'version', 'amount', 'dueDate', 'occurredAt', 'externalSystem',
      'voucherNumber', 'voucherLine', 'reason', 'evidence', 'reversalOfId', 'actorName', 'createdAt',
    ],
    properties: {
      id: { ...id, readOnly: true },
      kind: { type: 'string', enum: ['OPEN', 'PAYMENT', 'CREDIT', 'REFUND', 'REVERSAL', 'TERMS'], readOnly: true },
      version: { ...version, readOnly: true, description: 'Settlement account version captured by this immutable record.' },
      amount: { ...amount, type: ['string', 'null'], readOnly: true },
      dueDate: { ...nullableDateTime, readOnly: true },
      occurredAt: { ...dateTime, readOnly: true },
      externalSystem: { ...text(100), readOnly: true },
      voucherNumber: { ...text(200), readOnly: true },
      voucherLine: { ...text(200), readOnly: true },
      reason: { ...reason, readOnly: true },
      evidence: { type: 'array', items: evidence, readOnly: true },
      reversalOfId: { type: ['string', 'null'], minLength: 1, maxLength: 200, readOnly: true },
      actorName: { ...text(300), readOnly: true },
      createdAt: { ...dateTime, readOnly: true },
    },
  };
  core.schemas.SettlementRecord = record;

  const amounts = {
    type: 'object',
    additionalProperties: false,
    required: ['currency', 'initialAmount', 'grossPaid', 'refunded', 'effectivePaid', 'creditReduction', 'adjustedDue', 'unpaid', 'overpaid', 'pendingRefund'],
    properties: {
      currency: { const: 'USD', enum: ['USD'], readOnly: true },
      initialAmount: { ...amount, readOnly: true },
      grossPaid: { ...amount, readOnly: true },
      refunded: { ...amount, readOnly: true },
      effectivePaid: { ...amount, readOnly: true },
      creditReduction: { ...amount, readOnly: true },
      adjustedDue: { ...amount, readOnly: true },
      unpaid: { ...amount, readOnly: true },
      overpaid: { ...amount, readOnly: true },
      pendingRefund: { ...amount, readOnly: true },
    },
  };
  core.schemas.SettlementAmounts = amounts;

  const accountBaseProperties = {
    id: { ...id, readOnly: true },
    orderId: { ...id, readOnly: true },
    currency: { const: 'USD', enum: ['USD'], readOnly: true },
    initialAmount: { ...amount, readOnly: true },
    dueDate: { ...dateTime, readOnly: true },
    version: { ...version, readOnly: true },
    createdAt: { ...dateTime, readOnly: true },
    amounts: { ...schemaRef('SettlementAmounts'), readOnly: true },
    records: { type: 'array', items: schemaRef('SettlementRecord'), readOnly: true },
  };
  const accountBaseRequired = ['id', 'orderId', 'currency', 'initialAmount', 'dueDate', 'version', 'createdAt', 'amounts', 'records'];
  core.schemas.SettlementReceivableAccount = {
    type: 'object',
    additionalProperties: false,
    required: [...accountBaseRequired, 'side', 'purchaseCommitmentId', 'sourceSnapshot'],
    properties: {
      ...accountBaseProperties,
      side: { const: 'RECEIVABLE', enum: ['RECEIVABLE'], readOnly: true },
      purchaseCommitmentId: { type: 'null', readOnly: true },
      sourceSnapshot: { ...schemaRef('SettlementReceivableSourceSnapshot'), readOnly: true },
    },
    description: 'Accounts receivable projection. This is the only settlement side returned to users without settlement.view_cost.',
  };
  core.schemas.SettlementPayableAccount = {
    type: 'object',
    additionalProperties: false,
    required: [...accountBaseRequired, 'side', 'purchaseCommitmentId', 'sourceSnapshot'],
    properties: {
      ...accountBaseProperties,
      side: { const: 'PAYABLE', enum: ['PAYABLE'], readOnly: true },
      purchaseCommitmentId: { ...id, readOnly: true },
      sourceSnapshot: { ...schemaRef('SettlementPayableSourceSnapshot'), readOnly: true },
    },
    description: 'Accounts payable projection. Every field in this branch requires settlement.view_cost.',
    'x-aerolink-capability': 'settlement.view_cost',
  };
  core.schemas.SettlementAccount = {
    oneOf: [schemaRef('SettlementReceivableAccount'), schemaRef('SettlementPayableAccount')],
    discriminator: { propertyName: 'side', mapping: {
      RECEIVABLE: '#/components/schemas/SettlementReceivableAccount',
      PAYABLE: '#/components/schemas/SettlementPayableAccount',
    } },
  };
  core.schemas.SettlementOrderList = {
    type: 'object',
    additionalProperties: false,
    required: ['orderId', 'accounts'],
    properties: {
      orderId: { ...id, readOnly: true },
      accounts: { type: 'array', items: schemaRef('SettlementAccount'), readOnly: true },
    },
    description: 'Order-scoped settlement accounts. The route filters PAYABLE accounts unless settlement.view_cost is granted.',
  };

  const commonCreate = {
    orderId: id,
    dueDate: dateTime,
    occurredAt: dateTime,
    externalSystem: text(100),
    voucherNumber: text(200),
    voucherLine: text(200),
    reason,
    evidenceIds,
  };
  const commonCreateRequired = ['orderId', 'dueDate', 'occurredAt', 'externalSystem', 'voucherNumber', 'voucherLine', 'reason', 'evidenceIds'];
  core.schemas.SettlementReceivableCreateRequest = {
    type: 'object',
    additionalProperties: false,
    required: [...commonCreateRequired, 'side'],
    properties: { ...commonCreate, side: { const: 'RECEIVABLE', enum: ['RECEIVABLE'] }, purchaseCommitmentId: false },
  };
  core.schemas.SettlementPayableCreateRequest = {
    type: 'object',
    additionalProperties: false,
    required: [...commonCreateRequired, 'side', 'purchaseCommitmentId'],
    properties: { ...commonCreate, side: { const: 'PAYABLE', enum: ['PAYABLE'] }, purchaseCommitmentId: id },
    description: 'Creates an accounts-payable settlement account from a confirmed USD purchase commitment; requires settlement.view_cost.',
    'x-aerolink-capability': 'settlement.view_cost',
  };
  core.schemas.SettlementCreateRequest = {
    oneOf: [schemaRef('SettlementReceivableCreateRequest'), schemaRef('SettlementPayableCreateRequest')],
    discriminator: { propertyName: 'side', mapping: {
      RECEIVABLE: '#/components/schemas/SettlementReceivableCreateRequest',
      PAYABLE: '#/components/schemas/SettlementPayableCreateRequest',
    } },
    description: 'Strict USD settlement account request. Amounts are derived from the current order or confirmed purchase commitment; clients cannot supply an amount.',
  };

  const commonRecord = {
    version,
    occurredAt: dateTime,
    externalSystem: text(100),
    voucherNumber: text(200),
    voucherLine: text(200),
    reason,
    evidenceIds,
  };
  const commonRecordRequired = ['version', 'occurredAt', 'externalSystem', 'voucherNumber', 'voucherLine', 'reason', 'evidenceIds'];
  core.schemas.SettlementAmountRecordRequest = {
    type: 'object',
    additionalProperties: false,
    required: [...commonRecordRequired, 'kind', 'amount'],
    properties: {
      ...commonRecord,
      kind: { type: 'string', enum: ['PAYMENT', 'CREDIT', 'REFUND'] },
      amount: positiveAmount,
      reversalOfId: false,
      dueDate: false,
    },
  };
  core.schemas.SettlementReversalRecordRequest = {
    type: 'object',
    additionalProperties: false,
    required: [...commonRecordRequired, 'kind', 'reversalOfId'],
    properties: {
      ...commonRecord,
      kind: { const: 'REVERSAL', enum: ['REVERSAL'] },
      amount: false,
      reversalOfId: id,
      dueDate: false,
    },
  };
  core.schemas.SettlementTermsRecordRequest = {
    type: 'object',
    additionalProperties: false,
    required: [...commonRecordRequired, 'kind', 'dueDate'],
    properties: {
      ...commonRecord,
      kind: { const: 'TERMS', enum: ['TERMS'] },
      amount: false,
      reversalOfId: false,
      dueDate: dateTime,
    },
  };
  core.schemas.SettlementRecordRequest = {
    oneOf: [
      schemaRef('SettlementAmountRecordRequest'),
      schemaRef('SettlementReversalRecordRequest'),
      schemaRef('SettlementTermsRecordRequest'),
    ],
    discriminator: { propertyName: 'kind', mapping: {
      PAYMENT: '#/components/schemas/SettlementAmountRecordRequest',
      CREDIT: '#/components/schemas/SettlementAmountRecordRequest',
      REFUND: '#/components/schemas/SettlementAmountRecordRequest',
      REVERSAL: '#/components/schemas/SettlementReversalRecordRequest',
      TERMS: '#/components/schemas/SettlementTermsRecordRequest',
    } },
    description: 'Append-only settlement voucher. version is a required compare-and-set token; history cannot be edited in place.',
  };

  const envelope = (data) => ({
    type: 'object',
    additionalProperties: false,
    required: ['success', 'data'],
    properties: { success: { const: true }, data },
  });
  core.schemas.SettlementAccountEnvelope = envelope(schemaRef('SettlementAccount'));
  core.schemas.SettlementOrderListEnvelope = envelope(schemaRef('SettlementOrderList'));
  core.requestBodies.SettlementCreate = {
    required: true,
    content: { 'application/json': { schema: schemaRef('SettlementCreateRequest') } },
  };
  core.requestBodies.SettlementRecord = {
    required: true,
    content: { 'application/json': { schema: schemaRef('SettlementRecordRequest') } },
  };
  core.responses.SettlementAccount = {
    description: 'Current settlement account projection. PAYABLE and its cost/source fields require settlement.view_cost.',
    content: { 'application/json': { schema: schemaRef('SettlementAccountEnvelope') } },
  };
  core.responses.SettlementOrderList = {
    description: 'Order-scoped AR/AP settlement list. Sales receives AR only; AP requires settlement.view_cost.',
    content: { 'application/json': { schema: schemaRef('SettlementOrderListEnvelope') } },
  };

  const errors = () => Object.fromEntries(
    [400, 401, 403, 404, 409, 422, 429, 500]
      .map((status) => [String(status), { $ref: '#/components/responses/Error' }]),
  );
  const configure = (routePath, method, responseName, status, description, requestName) => {
    const operation = paths[routePath]?.[method];
    if (!operation) throw new Error(`Settlement route missing from catalog: ${method.toUpperCase()} ${routePath}`);
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = description;
    operation.responses = { [status]: responseRef(responseName), ...errors() };
    operation.parameters = (operation.parameters ?? []).filter((parameter) => parameter.name !== 'Idempotency-Key');
    if (requestName) {
      operation.requestBody = requestBodyRef(requestName);
      operation.parameters.push({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
        description: 'Required stable key for retry-safe settlement writes; replays are re-authorized against current scope.',
        schema: { type: 'string', minLength: 1, maxLength: 255 },
      });
    } else {
      delete operation.requestBody;
    }
    return operation;
  };

  const list = configure(
    '/api/settlements', 'get', 'SettlementOrderList', '200',
    'Lists settlement accounts for one modern order. orderId is the only accepted query parameter; users without settlement.view_cost receive receivables only and never payable/cost data.',
  );
  list.parameters = [...(list.parameters ?? []), { name: 'orderId', in: 'query', required: true, schema: id }];
  list['x-aerolink-strict-query'] = true;
  configure(
    '/api/settlements/{id}', 'get', 'SettlementAccount', '200',
    'Reads one current settlement account under order scope. A payable account requires settlement.view_cost; historical records are append-only.',
  );
  const create = configure(
    '/api/settlements', 'post', 'SettlementAccount', '201',
    'Creates one USD receivable or payable account from current order/purchase facts. The request cannot supply an amount; PAYABLE requires settlement.view_cost and a confirmed purchase commitment.',
    'SettlementCreate',
  );
  const recordWrite = configure(
    '/api/settlements/{id}/records', 'post', 'SettlementAccount', '201',
    'Appends one immutable USD external voucher with a required version CAS. Existing history is never edited; replay and scope are rechecked.',
    'SettlementRecord',
  );
  for (const operation of [create, recordWrite]) {
    if (!operation.parameters?.some((parameter) => parameter.name === 'Idempotency-Key' && parameter.required === true)) {
      throw new Error('Settlement write is missing required Idempotency-Key');
    }
  }
}
