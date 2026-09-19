/**
 * Contract for the commercial quotation revision boundary.
 *
 * Revision history is deliberately a metadata-only projection.  It must not
 * inherit the quotation cost fields because the route is also exposed to
 * callers that can read quotation metadata without quotation.view_cost.
 */
export function applyQuotationRevisionContract(paths, core) {
  const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
  const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });
  const requestBodyRef = (name) => ({ $ref: `#/components/requestBodies/${name}` });
  const errorResponses = () => Object.fromEntries(
    [400, 401, 403, 404, 409, 422, 429, 500]
      .map((status) => [String(status), { $ref: '#/components/responses/Error' }]),
  );

  const revisionMetadata = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'quoteNumber',
      'commercialRevision',
      'revisionOfId',
      'revisionRootId',
      'revisionReason',
      'supersededAt',
      'createdAt',
      'status',
      'expiryDate',
    ],
    properties: {
      id: { type: 'string', minLength: 1, readOnly: true },
      quoteNumber: { type: 'string', minLength: 1, readOnly: true },
      commercialRevision: { type: 'integer', minimum: 1, readOnly: true },
      revisionOfId: { type: ['string', 'null'], readOnly: true },
      revisionRootId: { type: ['string', 'null'], readOnly: true },
      revisionReason: { type: ['string', 'null'], readOnly: true },
      supersededAt: { type: ['string', 'null'], format: 'date-time', readOnly: true },
      createdAt: { type: 'string', format: 'date-time', readOnly: true },
      status: {
        type: 'string',
        enum: ['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'accepted', 'expired', 'withdrawn'],
        readOnly: true,
      },
      // The route serializes the Prisma Date directly, so this is RFC 3339
      // date-time rather than the date-only representation of main quotes.
      expiryDate: { type: 'string', format: 'date-time', readOnly: true },
      // Omitted when the revision has no successor.  It is intentionally
      // optional instead of required-null to match JSON serialization of an
      // undefined Prisma relation projection.
      supersededById: { type: 'string', minLength: 1, readOnly: true },
    },
  };

  core.schemas.QuotationRevision = revisionMetadata;
  core.schemas.QuotationRevisionListEnvelope = {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { const: true },
      data: { type: 'array', items: schemaRef('QuotationRevision') },
    },
    additionalProperties: true,
  };

  // The regular quotation request is a legacy/modern union.  `allOf` keeps
  // that union intact while making validityDays mandatory for revisions.
  core.schemas.QuotationReviseRequest = {
    type: 'object',
    required: ['version', 'reason', 'quotation'],
    properties: {
      version: { type: 'integer', minimum: 1 },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      quotation: {
        allOf: [
          schemaRef('QuotationCreateRequest'),
          {
            type: 'object',
            required: ['validityDays'],
            properties: { validityDays: { type: 'integer', minimum: 1 } },
          },
        ],
      },
    },
    additionalProperties: false,
  };

  core.schemas.QuotationRevisionCreated = {
    allOf: [
      schemaRef('Quotation'),
      {
        type: 'object',
        required: ['previousQuotationId'],
        properties: { previousQuotationId: { type: 'string', minLength: 1, readOnly: true } },
        additionalProperties: true,
      },
    ],
  };
  core.schemas.QuotationRevisionCreatedEnvelope = {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { const: true },
      data: schemaRef('QuotationRevisionCreated'),
    },
    additionalProperties: true,
  };

  core.requestBodies.QuotationRevise = {
    required: true,
    content: { 'application/json': { schema: schemaRef('QuotationReviseRequest') } },
  };
  core.responses.QuotationRevisionCreated = {
    description: 'Created draft quotation revision response',
    content: { 'application/json': { schema: schemaRef('QuotationRevisionCreatedEnvelope') } },
  };
  core.responses.QuotationRevisionList = {
    description: 'Quotation revision metadata response without commercial cost fields',
    content: { 'application/json': { schema: schemaRef('QuotationRevisionListEnvelope') } },
  };

  // Main quotation projections carry revision identity as read-only metadata.
  // The successor relation is optional because JSON omits it on the latest
  // revision and on a quotation with no successor.
  Object.assign(core.schemas.Quotation.properties, {
    commercialRevision: { type: 'integer', minimum: 1, readOnly: true },
    revisionOfId: { type: ['string', 'null'], readOnly: true },
    revisionRootId: { type: ['string', 'null'], readOnly: true },
    revisionReason: { type: ['string', 'null'], readOnly: true },
    supersededAt: { type: ['string', 'null'], format: 'date-time', readOnly: true },
    supersededById: { type: 'string', minLength: 1, readOnly: true },
  });
  core.schemas.Quotation.required = [
    ...new Set([...(core.schemas.Quotation.required ?? []), 'commercialRevision']),
  ];

  const configure = (routePath, method, responseName, status, description) => {
    const operation = paths[routePath]?.[method];
    if (!operation) throw new Error(`Quotation revision route missing from catalog: ${method.toUpperCase()} ${routePath}`);
    operation['x-aerolink-contract-status'] = 'contracted';
    delete operation['x-aerolink-deferred-reason'];
    operation.description = description;
    operation.responses = { [status]: responseRef(responseName), ...errorResponses() };
    return operation;
  };

  const revisions = configure(
    '/api/quotations/{id}/revisions',
    'get',
    'QuotationRevisionList',
    '200',
    'Returns revision metadata only; commercial cost fields are not exposed by this history projection.',
  );
  revisions.requestBody = undefined;

  const revise = configure(
    '/api/quotations/{id}/revise',
    'post',
    'QuotationRevisionCreated',
    '201',
    'Creates a new DRAFT commercial quotation revision under a version and reason check. validityDays is required for the nested quotation request.',
  );
  revise.requestBody = requestBodyRef('QuotationRevise');
}
