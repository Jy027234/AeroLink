function objectSchema(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function schemaRef(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function responseRef(name) {
  return { $ref: `#/components/responses/${name}` };
}

function requestBody(schema) {
  return { required: true, content: { 'application/json': { schema } } };
}

function resourceResponse(description, schema) {
  return { description, content: { 'application/json': { schema: schemaRef(schema) } } };
}

function successEnvelope(data) {
  return objectSchema({ success: { type: 'boolean', const: true }, data });
}

/**
 * Reply-to-inquiry matching and supplier quote draft confirmation are one
 * sourcing boundary. AI output remains an editable draft; only the explicit
 * confirm operation can create formal SupplierQuote rows.
 */
export function applySourcingEmailContract(paths, core) {
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const nullableId = { type: ['string', 'null'], minLength: 1, maxLength: 200 };
  const nullableText = { type: ['string', 'null'] };
  const date = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  const dateTime = { type: ['string', 'null'], format: 'date-time' };
  const optionalNumber = { type: ['number', 'null'], minimum: 0 };
  const optionalInteger = { type: ['integer', 'null'], minimum: 0 };

  core.schemas.InquiryEmailLink = objectSchema({
    id,
    emailId: id,
    inquiryId: id,
    method: { type: 'string', enum: ['AUTO_MESSAGE_ID', 'MANUAL'] },
    confirmationStatus: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'REJECTED'] },
    manualReason: nullableText,
    confirmedAt: dateTime,
    confirmedById: nullableId,
    createdAt: { type: 'string', format: 'date-time' },
    inquiry: {
      oneOf: [objectSchema({ id, inquiryNumber: { type: 'string' }, supplierId: id }), { type: 'null' }],
    },
  }, ['id', 'emailId', 'inquiryId', 'method', 'confirmationStatus', 'manualReason', 'confirmedAt', 'confirmedById', 'createdAt', 'inquiry']);

  core.schemas.EmailAttachmentRecord = objectSchema({
    id,
    filename: { type: 'string' },
    contentType: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    contentId: nullableText,
    storedObjectId: id,
    downloadUrl: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  });

  Object.assign(core.schemas.Email.properties, {
    threadMatchStatus: { type: ['string', 'null'], enum: ['PENDING', 'MATCHED', 'NEEDS_REVIEW', 'UNMATCHED', null] },
    threadMatchReason: nullableText,
    attachmentStatus: { type: ['string', 'null'], enum: ['NONE', 'STORED', 'PARTIAL', 'REJECTED', null] },
    attachmentError: nullableText,
    inquiryLinks: { type: 'array', items: schemaRef('InquiryEmailLink') },
    attachmentRecords: { type: 'array', items: schemaRef('EmailAttachmentRecord') },
  });
  core.schemas.Email.required = [...new Set([
    ...core.schemas.Email.required,
    'threadMatchStatus', 'threadMatchReason', 'attachmentStatus', 'attachmentError',
    'inquiryLinks', 'attachmentRecords',
  ])];

  core.schemas.EmailSummary = objectSchema({
    total: { type: 'integer', minimum: 0 },
    aog: { type: 'integer', minimum: 0 },
    standard: { type: 'integer', minimum: 0 },
    inquiry: { type: 'integer', minimum: 0 },
    unread: { type: 'integer', minimum: 0 },
    spam: { type: 'integer', minimum: 0 },
  });
  core.schemas.EmailListEnvelope.properties.summary = schemaRef('EmailSummary');
  core.schemas.EmailListEnvelope.required = [...new Set([
    ...core.schemas.EmailListEnvelope.required,
    'pagination',
    'summary',
  ])];

  core.schemas.EmailInquiryLinkRequest = objectSchema({
    inquiryId: id,
    manualReason: { type: 'string', minLength: 5, maxLength: 500 },
  }, ['inquiryId']);
  core.schemas.InquiryEmailLinkEnvelope = successEnvelope(schemaRef('InquiryEmailLink'));

  core.schemas.SupplierQuoteDraftItem = objectSchema({
    itemKey: id,
    inquiryItemId: nullableId,
    partNumber: nullableText,
    description: nullableText,
    quantityUnit: nullableText,
    quantity: { type: ['number', 'null'], exclusiveMinimum: 0 },
    unitPrice: optionalNumber,
    currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
    leadTimeDays: optionalInteger,
    leadTimeMinDays: optionalInteger,
    leadTimeMaxDays: optionalInteger,
    validUntil: date,
    condition: nullableText,
    certificate: {
      oneOf: [
        { type: 'string' },
        { type: 'boolean' },
        { type: 'array', items: { type: 'string' } },
        { type: 'null' },
      ],
    },
    taxIncluded: { type: ['boolean', 'null'] },
    freightIncluded: { type: ['boolean', 'null'] },
    incoterm: { type: ['string', 'null'], minLength: 2, maxLength: 20 },
    evidenceText: nullableText,
    notes: nullableText,
  }, ['itemKey']);
  core.schemas.SupplierQuoteDraftPayload = objectSchema({
    items: { type: 'array', minItems: 0, maxItems: 100, items: schemaRef('SupplierQuoteDraftItem') },
  });
  core.schemas.SupplierQuoteDraft = objectSchema({
    id,
    emailId: id,
    inquiryId: id,
    supplierId: id,
    status: { type: 'string', enum: ['DRAFT', 'CONFIRMED'] },
    version: { type: 'integer', minimum: 1 },
    payload: schemaRef('SupplierQuoteDraftPayload'),
    aiProvider: nullableText,
    aiModel: nullableText,
    aiPromptVersion: nullableText,
    aiConfidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    aiMetadata: { type: ['object', 'null'], additionalProperties: true },
    confirmedAt: dateTime,
    confirmedById: nullableId,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    email: { type: 'object', additionalProperties: true },
    inquiry: { type: 'object', additionalProperties: true },
    supplier: { type: 'object', additionalProperties: true },
    supplierQuotes: { type: 'array', items: { type: 'object', additionalProperties: true } },
  }, [
    'id', 'emailId', 'inquiryId', 'supplierId', 'status', 'version', 'payload',
    'aiProvider', 'aiModel', 'aiPromptVersion', 'aiConfidence', 'aiMetadata',
    'confirmedAt', 'confirmedById', 'createdAt', 'updatedAt',
    'email', 'inquiry', 'supplier', 'supplierQuotes',
  ]);
  core.schemas.SupplierQuoteDraftEnvelope = successEnvelope(schemaRef('SupplierQuoteDraft'));
  core.schemas.SupplierQuoteDraftNullableEnvelope = successEnvelope({
    oneOf: [schemaRef('SupplierQuoteDraft'), { type: 'null' }],
  });
  core.schemas.SupplierQuoteDraftCreateRequest = objectSchema({
    emailId: id,
    inquiryId: id,
    payload: schemaRef('SupplierQuoteDraftPayload'),
  });
  core.schemas.SupplierQuoteDraftExtractRequest = objectSchema({ emailId: id, inquiryId: id });
  core.schemas.SupplierQuoteDraftPatchRequest = objectSchema({
    expectedVersion: { type: 'integer', minimum: 1 },
    payload: schemaRef('SupplierQuoteDraftPayload'),
  });
  core.schemas.SupplierQuoteDraftConfirmRequest = objectSchema({ expectedVersion: { type: 'integer', minimum: 1 } });
  core.schemas.SupplierQuoteDraftConfirmResult = objectSchema({
    draftId: id,
    status: { type: 'string', const: 'CONFIRMED' },
    version: { type: 'integer', minimum: 1 },
    reused: { type: 'boolean' },
    supplierQuoteIds: { type: 'array', items: id },
    createdSupplierQuoteIds: { type: 'array', items: id },
    reusedSupplierQuoteIds: { type: 'array', items: id },
    supplierQuotes: { type: 'array', items: schemaRef('SupplierQuote') },
  });
  core.schemas.SupplierQuoteDraftConfirmEnvelope = successEnvelope(schemaRef('SupplierQuoteDraftConfirmResult'));

  core.schemas.SourcingAiTask = objectSchema({
    id,
    actorId: id,
    type: { type: 'string', const: 'supplier_quote_extraction' },
    emailId: id,
    inquiryId: id,
    status: { type: 'string', enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
    attempt: { type: 'integer', minimum: 1 },
    maxAttempts: { type: 'integer', minimum: 1 },
    draftId: nullableId,
    errorSummary: nullableText,
    createdAt: { type: 'string', format: 'date-time' },
    startedAt: dateTime,
    completedAt: dateTime,
    cancelledAt: dateTime,
    updatedAt: { type: 'string', format: 'date-time' },
  });
  core.schemas.SourcingAiTaskCreateRequest = objectSchema({
    type: { type: 'string', const: 'supplier_quote_extraction' },
    emailId: id,
    inquiryId: id,
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
  });
  core.schemas.SourcingAiTaskEnvelope = successEnvelope(schemaRef('SourcingAiTask'));
  core.schemas.SourcingAiTaskListEnvelope = successEnvelope({
    type: 'array',
    items: schemaRef('SourcingAiTask'),
  });

  core.responses.InquiryEmailLink = resourceResponse('Confirmed email-to-inquiry link', 'InquiryEmailLinkEnvelope');
  core.responses.SupplierQuoteDraft = resourceResponse('Editable supplier quote draft', 'SupplierQuoteDraftEnvelope');
  core.responses.SupplierQuoteDraftNullable = resourceResponse('Latest supplier quote draft, or null when none exists', 'SupplierQuoteDraftNullableEnvelope');
  core.responses.SupplierQuoteDraftConfirm = resourceResponse('Confirmed draft and formal supplier quote identities', 'SupplierQuoteDraftConfirmEnvelope');
  core.responses.SourcingAiTask = resourceResponse('Server-owned sourcing AI task', 'SourcingAiTaskEnvelope');
  core.responses.SourcingAiTaskList = resourceResponse('Visible server-owned sourcing AI tasks', 'SourcingAiTaskListEnvelope');

  const errorResponses = Object.fromEntries([400, 401, 403, 404, 409, 422, 429, 500]
    .map((status) => [String(status), responseRef('Error')]));
  const configure = (path, method, description, body, successResponse, successStatus = '200') => {
    const operation = paths[path]?.[method];
    if (!operation) throw new Error(`Missing sourcing email operation ${method.toUpperCase()} ${path}`);
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = description;
    operation.responses = { [successStatus]: responseRef(successResponse), ...errorResponses };
    if (body) operation.requestBody = requestBody(body);
  };

  const emailList = paths['/api/emails']?.get;
  if (!emailList) throw new Error('Missing GET /api/emails');
  emailList.parameters = [
    ...emailList.parameters.filter((parameter) => !['inquiryId', 'needsInquiryMatch'].includes(parameter.name)),
    { name: 'inquiryId', in: 'query', required: false, schema: id },
    {
      name: 'needsInquiryMatch',
      in: 'query',
      required: false,
      description: 'Use true to return only UNMATCHED or NEEDS_REVIEW emails without any CONFIRMED inquiry link. PENDING emails are excluded. This cannot be combined with inquiryId.',
      schema: { type: 'string', enum: ['true', 'false'] },
    },
  ];
  emailList.description = 'Lists inbound email with pagination and a database-wide summary. needsInquiryMatch=true filters to unresolved thread matches without a confirmed inquiry link; it cannot be combined with inquiryId. inquiryId filters by persisted links; it never guesses by subject or part number.';

  configure(
    '/api/emails/{id}/inquiry-links',
    'post',
    'Confirms a manual email-to-inquiry link. A sender mismatch requires an explicit manual reason and is retained for audit; automatic matching remains stricter.',
    schemaRef('EmailInquiryLinkRequest'),
    'InquiryEmailLink',
  );
  configure(
    '/api/supplier-quote-drafts',
    'post',
    'Creates an editable source-linked draft from confirmed email and inquiry facts. Missing or non-USD values remain draft data and do not create a SupplierQuote.',
    schemaRef('SupplierQuoteDraftCreateRequest'),
    'SupplierQuoteDraft',
    '201',
  );
  configure(
    '/api/supplier-quote-drafts',
    'get',
    'Restores the latest persisted draft for one exact email and inquiry pair so a page refresh does not lose the editable work item.',
    null,
    'SupplierQuoteDraftNullable',
  );
  paths['/api/supplier-quote-drafts'].get.parameters = [
    { name: 'emailId', in: 'query', required: true, schema: id },
    { name: 'inquiryId', in: 'query', required: true, schema: id },
  ];
  configure(
    '/api/supplier-quote-drafts/extract',
    'post',
    'Runs the published supplier quote extraction agent against a confirmed linked email and saves only an editable draft. Evidence must be found in the original email; no formal quote or business action is created.',
    schemaRef('SupplierQuoteDraftExtractRequest'),
    'SupplierQuoteDraft',
    '201',
  );
  configure(
    '/api/supplier-quote-drafts/{id}',
    'get',
    'Reads an editable or confirmed supplier quote draft with its source and generated SupplierQuote identities.',
    null,
    'SupplierQuoteDraft',
  );
  configure(
    '/api/supplier-quote-drafts/{id}',
    'patch',
    'Revises an unconfirmed supplier quote draft using optimistic version checking. Confirmed drafts are immutable.',
    schemaRef('SupplierQuoteDraftPatchRequest'),
    'SupplierQuoteDraft',
  );
  configure(
    '/api/supplier-quote-drafts/{id}/confirm',
    'post',
    'Explicitly confirms one complete draft version. Every item must bind to an immutable inquiry item and provide USD price, positive quantity and one lead-time value. Replays return the same formal quotes.',
    schemaRef('SupplierQuoteDraftConfirmRequest'),
    'SupplierQuoteDraftConfirm',
  );
  configure(
    '/api/sourcing-ai-tasks',
    'post',
    'Queues one server-owned supplier quote extraction task for the independent Worker. The persisted task is returned immediately; failures retain a safe summary, and only an editable draft may be created.',
    schemaRef('SourcingAiTaskCreateRequest'),
    'SourcingAiTask',
    '201',
  );
  paths['/api/sourcing-ai-tasks'].post.responses['200'] = responseRef('SourcingAiTask');
  configure(
    '/api/sourcing-ai-tasks',
    'get',
    'Lists sourcing AI tasks owned by the authenticated actor; administrators may inspect all tasks. Raw email and model inputs are never returned.',
    null,
    'SourcingAiTaskList',
  );
  paths['/api/sourcing-ai-tasks'].get.parameters = [
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
    { name: 'emailId', in: 'query', required: false, schema: id },
    { name: 'inquiryId', in: 'query', required: false, schema: id },
  ];
  configure(
    '/api/sourcing-ai-tasks/{id}',
    'get',
    'Reads one actor-owned sourcing AI task, or any task for an administrator.',
    null,
    'SourcingAiTask',
  );
  configure(
    '/api/sourcing-ai-tasks/{id}/retry',
    'post',
    'Requeues a failed task on the same persistent record when its attempt ceiling has not been reached. Execution occurs in the independent Worker and cannot create a formal supplier quote.',
    null,
    'SourcingAiTask',
  );
  configure(
    '/api/sourcing-ai-tasks/{id}/cancel',
    'post',
    'Cancels a pending, running, or failed task using a conditional state transition. A running model request may finish, but its stale result cannot create a draft after cancellation.',
    null,
    'SourcingAiTask',
  );
}
