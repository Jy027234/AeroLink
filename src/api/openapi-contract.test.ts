import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Operation = {
  requestBody?: unknown;
  security?: unknown;
  parameters?: unknown[];
  responses: Record<string, unknown>;
  'x-aerolink-contract-status'?: string;
  'x-aerolink-strict-query'?: boolean;
};

type Schema = {
  $ref?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  allOf?: Schema[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
};

type Contract = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    requestBodies: Record<string, unknown>;
    responses: Record<string, { headers: Record<string, unknown> }>;
    schemas: Record<string, Schema>;
  };
};

const contract = JSON.parse(
  readFileSync('contracts/openapi/openapi.json', 'utf8'),
) as Contract;

function operation(method: string, routePath: string) {
  return contract.paths[routePath]?.[method.toLowerCase()];
}

function resolveSchema(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split('/').pop();
  if (!name || !contract.components.schemas[name]) {
    throw new Error(`Unknown schema reference: ${schema.$ref}`);
  }
  return contract.components.schemas[name];
}

function schemaBranches(name: string): Schema[] {
  const schema = resolveSchema(contract.components.schemas[name]);
  return schema.oneOf?.map(resolveSchema) ?? [schema];
}

function costSourceBranches(schema: Schema): Schema[] {
  const rules = schema.allOf?.find((item) => item.oneOf);
  return rules?.oneOf?.map(resolveSchema) ?? [];
}

describe('OpenAPI representative contract invariants', () => {
  it('describes cookie-based login and refresh without exposing refresh tokens', () => {
    const login = operation('POST', '/api/auth/login');
    const refresh = operation('POST', '/api/auth/refresh');

    expect(login.requestBody).toEqual({ $ref: '#/components/requestBodies/Login' });
    expect(login.security).toEqual([]);
    expect(login.responses['200']).toEqual({ $ref: '#/components/responses/AuthLogin' });
    expect(refresh.security).toEqual([{ refreshCookie: [] }]);
    expect(refresh.responses['200']).toEqual({ $ref: '#/components/responses/AuthRefresh' });
    expect(contract.components.responses.AuthRefresh.headers['Set-Cookie']).toBeDefined();
  });

  it('contracts password assistance and managed-session boundaries', () => {
    const activation = operation('POST', '/api/auth/activate');
    const forgot = operation('POST', '/api/auth/forgot-password');
    const reset = operation('POST', '/api/auth/reset-password');
    const sessions = operation('GET', '/api/auth/sessions');
    const securityEvents = operation('GET', '/api/auth/security-events');

    expect(activation.requestBody).toEqual({ $ref: '#/components/requestBodies/TokenPassword' });
    expect(activation.responses['200']).toEqual({ $ref: '#/components/responses/AuthLogin' });
    expect(forgot.requestBody).toEqual({ $ref: '#/components/requestBodies/ForgotPassword' });
    expect(forgot.responses['200']).toEqual({ $ref: '#/components/responses/Message' });
    expect(reset.requestBody).toEqual({ $ref: '#/components/requestBodies/TokenPassword' });
    expect(sessions.responses['200']).toEqual({ $ref: '#/components/responses/Sessions' });
    expect(securityEvents.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'limit', in: 'query' }),
      expect.objectContaining({ name: 'status', in: 'query' }),
    ]));
  });

  it('describes pagination and stable idempotency headers for core writes', () => {
    const list = operation('GET', '/api/rfqs');
    const create = operation('POST', '/api/rfqs');

    expect(list.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'page', in: 'query' }),
      expect.objectContaining({ name: 'limit', in: 'query' }),
      expect.objectContaining({ name: 'direction', in: 'query' }),
    ]));
    expect(create.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }),
    ]));
  });

  it('describes upload, binary download and inbound webhook signature boundaries', () => {
    const upload = operation('POST', '/api/upload');
    const pdf = operation('GET', '/api/quotations/{id}/pdf');
    const inbound = operation('POST', '/api/inbound-webhooks/endpoints');

    expect(upload.requestBody).toEqual({ $ref: '#/components/requestBodies/MultipartUpload' });
    expect(pdf.responses['200']).toEqual({ $ref: '#/components/responses/PdfDocument' });
    expect(inbound.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'X-Webhook-Signature', in: 'header', required: true }),
    ]));
  });

  it('contracts the first six domain vertical slices with DTO-specific schemas', () => {
    const domains = [
      ['rfqs', 'Rfq', 'RfqCreateRequest'],
      ['quotations', 'Quotation', 'QuotationCreateRequest'],
      ['orders', 'Order', 'OrderCreateRequest'],
      ['inventory', 'Inventory', 'InventoryCreateRequest'],
      ['customers', 'Customer', 'CustomerCreateRequest'],
      ['suppliers', 'Supplier', 'SupplierCreateRequest'],
    ] as const;

    for (const [path, resource, requestSchema] of domains) {
      const list = operation('GET', `/api/${path}`);
      const create = operation('POST', `/api/${path}`);

      expect(list['x-aerolink-contract-status']).toBe('contracted');
      expect(list.responses['200']).toEqual({ $ref: `#/components/responses/${resource}List` });
      expect(create['x-aerolink-contract-status']).toBe('contracted');
      expect(create.requestBody).toEqual({ $ref: `#/components/requestBodies/${resource}Create` });
      expect(create.responses['201']).toEqual({ $ref: `#/components/responses/${resource}` });
      expect(contract.components.schemas[resource].required).toBeDefined();
      const requestBranches = schemaBranches(requestSchema);
      expect(requestBranches.length).toBeGreaterThan(0);
      for (const requestBranch of requestBranches) {
        expect(requestBranch.properties).toBeDefined();
      }
    }
  });

  it('contracts transaction actions and operational exports without changing media boundaries', () => {
    const approve = operation('POST', '/api/quotations/{id}/approve');
    const withdraw = operation('POST', '/api/quotations/{id}/withdraw');
    const rfqExport = operation('GET', '/api/rfqs/export.csv');
    const quotationPdf = operation('GET', '/api/quotations/{id}/pdf');
    const reconciliation = operation('GET', '/api/inventory/reconciliation');

    expect(approve.requestBody).toEqual({ $ref: '#/components/requestBodies/QuotationApprove' });
    expect(approve.responses['200']).toEqual({ $ref: '#/components/responses/Action' });
    expect(withdraw.requestBody).toEqual({ $ref: '#/components/requestBodies/QuotationWithdraw' });
    expect(rfqExport.responses['200']).toEqual({ $ref: '#/components/responses/CsvExport' });
    expect(rfqExport.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'scope', in: 'query' }),
      expect.objectContaining({ name: 'confirm', in: 'query' }),
      expect.objectContaining({ name: 'maxRows', in: 'query' }),
    ]));
    expect(quotationPdf.responses['200']).toEqual({ $ref: '#/components/responses/PdfDocument' });
    expect(reconciliation.responses['200']).toEqual({ $ref: '#/components/responses/InventoryReconciliation' });
  });

  it('contracts document, certificate, webhook and outbox integration seams', () => {
    const documentCreate = operation('POST', '/api/document-templates');
    const certificateList = operation('GET', '/api/certificates');
    const certificateIssue = operation('POST', '/api/certificates/issue');
    const endpointCreate = operation('POST', '/api/webhooks/endpoints');
    const inbound = operation('POST', '/api/inbound-webhooks/{urlPath}');
    const outbox = operation('GET', '/api/outbox');
    const outboxReplay = operation('POST', '/api/outbox/{id}/retry');
    const phase2Replay = operation('POST', '/api/webhooks/phase2/replay/execute');

    expect(documentCreate['x-aerolink-contract-status']).toBe('contracted');
    expect(documentCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/DocumentTemplateCreate' });
    expect(documentCreate.responses['201']).toEqual({ $ref: '#/components/responses/DocumentTemplate' });
    expect(certificateList.responses['200']).toEqual({ $ref: '#/components/responses/CertificateList' });
    expect(certificateIssue.requestBody).toEqual({ $ref: '#/components/requestBodies/CertificateIssue' });
    expect(certificateIssue.responses['201']).toEqual({ $ref: '#/components/responses/Certificate' });
    expect(endpointCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/WebhookEndpointCreate' });
    expect(endpointCreate.responses['201']).toEqual({ $ref: '#/components/responses/WebhookEndpoint' });
    expect(inbound.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'X-Webhook-Signature', in: 'header', required: true }),
    ]));
    expect(inbound.responses['202']).toEqual({ $ref: '#/components/responses/InboundAccepted' });
    expect(outbox.responses['200']).toEqual({ $ref: '#/components/responses/OutboxList' });
    expect(outboxReplay.requestBody).toEqual({ $ref: '#/components/requestBodies/OutboxReplay' });
    expect(outboxReplay.responses['200']).toEqual({ $ref: '#/components/responses/OutboxEvent' });
    expect(phase2Replay['x-aerolink-contract-status']).toBe('contracted');
    expect(phase2Replay.requestBody).toEqual({ $ref: '#/components/requestBodies/WebhookPhase2Request' });
  });

  it('keeps health, metrics and authorized file-download boundaries explicit', () => {
    const health = operation('GET', '/api/health');
    const metrics = operation('GET', '/api/metrics');
    const file = operation('GET', '/api/files/{id}');

    expect(health.security).toEqual([]);
    expect(health.responses['200']).toEqual({ $ref: '#/components/responses/Health' });
    expect(metrics.security).toEqual([{ bearerAuth: [] }]);
    expect(metrics.responses['200']).toEqual({ $ref: '#/components/responses/Metrics' });
    expect(file.security).toEqual([{ bearerAuth: [] }]);
    expect(file.responses['200']).toEqual({ $ref: '#/components/responses/FileDownload' });
  });

  it('contracts managed users and mail administration without credential leakage', () => {
    const users = operation('GET', '/api/users');
    const emails = operation('GET', '/api/emails');
    const classify = operation('PATCH', '/api/emails/{id}/classify');
    const accounts = operation('GET', '/api/email-accounts');
    const createAccount = operation('POST', '/api/email-accounts');

    expect(users['x-aerolink-contract-status']).toBe('contracted');
    expect(users.responses['200']).toEqual({ $ref: '#/components/responses/ManagedUserList' });
    expect(emails.responses['200']).toEqual({ $ref: '#/components/responses/EmailList' });
    expect(emails.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'isRead', in: 'query' }),
      expect.objectContaining({ name: 'page', in: 'query' }),
    ]));
    expect(classify.requestBody).toEqual({ $ref: '#/components/requestBodies/EmailClassify' });
    expect(accounts.responses['200']).toEqual({ $ref: '#/components/responses/EmailAccountList' });
    expect(createAccount.requestBody).toEqual({ $ref: '#/components/requestBodies/EmailAccountCreate' });
    expect(contract.components.schemas.EmailAccountCreateRequest.properties).toMatchObject({ authCode: { writeOnly: true } });
  });

  it('contracts managed-user onboarding, supplier follow-up and supplier-quote actions', () => {
    const createUser = operation('POST', '/api/users');
    const updateUser = operation('PUT', '/api/users/{id}');
    const activationLink = operation('POST', '/api/users/{id}/activation-link');
    const followUpList = operation('GET', '/api/suppliers/follow-up-logs');
    const followUpCreate = operation('POST', '/api/suppliers/follow-up-logs');
    const invite = operation('POST', '/api/suppliers/invite');
    const supplierQuoteList = operation('GET', '/api/supplier-quotes');
    const supplierQuoteCreate = operation('POST', '/api/supplier-quotes');
    const supplierQuoteCompare = operation('POST', '/api/supplier-quotes/compare');
    const selectWinner = operation('POST', '/api/supplier-quotes/{id}/select-winner');

    expect(createUser.requestBody).toEqual({ $ref: '#/components/requestBodies/ManagedUserCreate' });
    expect(createUser.responses['201']).toEqual({ $ref: '#/components/responses/ManagedUserOnboarding' });
    expect(updateUser.requestBody).toEqual({ $ref: '#/components/requestBodies/ManagedUserUpdate' });
    expect(activationLink.responses['200']).toEqual({ $ref: '#/components/responses/ManagedUserOnboarding' });
    expect(contract.components.schemas.ManagedUserOnboarding.properties).toMatchObject({ activationToken: { type: 'string' } });

    expect(followUpList.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'supplierId', in: 'query' }),
      expect.objectContaining({ name: 'limit', in: 'query', schema: expect.objectContaining({ maximum: 200 }) }),
    ]));
    expect(followUpCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/SupplierFollowUpLogBatchCreate' });
    expect(invite.responses['410']).toEqual({ $ref: '#/components/responses/Error' });

    expect(supplierQuoteList.responses['200']).toEqual({ $ref: '#/components/responses/SupplierQuoteList' });
    expect(supplierQuoteCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/SupplierQuoteCreate' });
    expect(supplierQuoteCompare.requestBody).toEqual({ $ref: '#/components/requestBodies/SupplierQuoteCompare' });
    expect(selectWinner.responses['200']).toEqual({ $ref: '#/components/responses/SupplierQuoteWinner' });
    expect(contract.components.schemas.SupplierQuoteCompareRequest.properties).toMatchObject({
      rfqId: { type: 'string' },
      rfqLineId: { type: 'string' },
      inquiryId: { type: 'string' },
      inquiryItemId: { type: 'string' },
    });
    expect(contract.components.schemas.SupplierQuoteComparison.required).toEqual(expect.arrayContaining([
      'rfqLineId', 'inquiryItemId', 'partNumberGroups',
    ]));
    expect(contract.components.schemas.SupplierQuoteComparisonItem.properties).toMatchObject({
      comparisonEligibility: expect.objectContaining({ type: 'object' }),
      isExpired: { type: 'boolean' },
      coversRequiredQuantity: { type: ['boolean', 'null'] },
      quantityShortfall: { type: ['integer', 'null'], minimum: 0 },
      commercialTerms: expect.objectContaining({ type: 'object' }),
    });
    expect(contract.components.schemas.SupplierQuoteComparison.properties?.summary?.properties).toMatchObject({
      comparableQuoteCount: { type: 'integer', minimum: 0 },
      expiredQuoteCount: { type: 'integer', minimum: 0 },
      requiredQuantity: { type: ['integer', 'null'], minimum: 1 },
      remainingQuantityGap: { type: ['integer', 'null'], minimum: 0 },
    });
    expect(contract.components.schemas.SupplierQuoteUpdateRequest.properties).toMatchObject({
      status: { enum: ['pending', 'accepted', 'rejected', 'expired'] },
    });
  });

  it('contracts inquiry dispatch as queued delivery rather than immediate send', () => {
    const sendInquiry = operation('POST', '/api/inquiries/{id}/send');

    expect(sendInquiry.deprecated).toBeUndefined();
    expect(sendInquiry.requestBody).toEqual({ $ref: '#/components/requestBodies/InquirySend' });
    expect(sendInquiry.responses['202']).toEqual({ $ref: '#/components/responses/Inquiry' });
    expect(sendInquiry.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: false }),
    ]));
    expect(contract.components.schemas.Inquiry.properties).toMatchObject({
      deliveryStatus: { enum: ['draft', 'queued', 'sent', 'failed'], readOnly: true },
      latestOutboundEmail: { readOnly: true },
    });
  });

  it('keeps inbound quote extraction as a source-linked draft until explicit confirmation', () => {
    const emails = operation('GET', '/api/emails');
    const link = operation('POST', '/api/emails/{id}/inquiry-links');
    const createDraft = operation('POST', '/api/supplier-quote-drafts');
    const restoreDraft = operation('GET', '/api/supplier-quote-drafts');
    const extractDraft = operation('POST', '/api/supplier-quote-drafts/extract');
    const patchDraft = operation('PATCH', '/api/supplier-quote-drafts/{id}');
    const confirmDraft = operation('POST', '/api/supplier-quote-drafts/{id}/confirm');

    expect(emails.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'inquiryId', in: 'query' }),
      expect.objectContaining({
        name: 'needsInquiryMatch',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['true', 'false'] },
      }),
    ]));
    expect(emails.description).toContain('cannot be combined with inquiryId');
    expect(emails.responses['200']).toEqual({ $ref: '#/components/responses/EmailList' });
    expect(emails.responses['400']).toEqual({ $ref: '#/components/responses/Error' });
    expect(contract.components.schemas.EmailListEnvelope.required).toContain('pagination');
    expect(contract.components.schemas.EmailListEnvelope.required).toContain('summary');
    expect(contract.components.schemas.EmailListEnvelope.properties?.summary)
      .toEqual({ $ref: '#/components/schemas/EmailSummary' });
    expect(contract.components.schemas.EmailSummary.required).toEqual([
      'total', 'aog', 'standard', 'inquiry', 'unread', 'spam',
    ]);
    expect(contract.components.schemas.Email.required).toEqual(expect.arrayContaining([
      'threadMatchStatus', 'attachmentStatus', 'inquiryLinks', 'attachmentRecords',
    ]));
    expect(link.requestBody).toEqual(expect.objectContaining({ required: true }));
    expect(link.responses['200']).toEqual({ $ref: '#/components/responses/InquiryEmailLink' });
    expect(contract.components.schemas.InquiryEmailLink.required).toEqual(expect.arrayContaining([
      'id', 'emailId', 'inquiryId', 'confirmationStatus', 'confirmedAt', 'confirmedById', 'inquiry',
    ]));
    expect(createDraft.responses['201']).toEqual({ $ref: '#/components/responses/SupplierQuoteDraft' });
    expect(restoreDraft.responses['200']).toEqual({ $ref: '#/components/responses/SupplierQuoteDraftNullable' });
    expect(restoreDraft.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'emailId', in: 'query', required: true }),
      expect.objectContaining({ name: 'inquiryId', in: 'query', required: true }),
    ]));
    expect(extractDraft.responses['201']).toEqual({ $ref: '#/components/responses/SupplierQuoteDraft' });
    expect(patchDraft.responses['200']).toEqual({ $ref: '#/components/responses/SupplierQuoteDraft' });
    expect(confirmDraft.responses['200']).toEqual({ $ref: '#/components/responses/SupplierQuoteDraftConfirm' });

    const item = contract.components.schemas.SupplierQuoteDraftItem;
    expect(item.required).toEqual(['itemKey']);
    expect(item.properties).toMatchObject({
      inquiryItemId: { type: ['string', 'null'] },
      currency: { type: ['string', 'null'] },
      leadTimeMinDays: { type: ['integer', 'null'] },
      leadTimeMaxDays: { type: ['integer', 'null'] },
      taxIncluded: { type: ['boolean', 'null'] },
      freightIncluded: { type: ['boolean', 'null'] },
      incoterm: { type: ['string', 'null'], minLength: 2, maxLength: 20 },
      evidenceText: { type: ['string', 'null'] },
    });

    expect(contract.components.schemas.SupplierQuoteComparisonItem.required).toEqual(expect.arrayContaining([
      'commercialBasisKey', 'commercialBasisLabel',
    ]));
    expect(contract.components.schemas.SupplierQuoteComparisonItem.properties?.commercialTerms).toMatchObject({
      required: ['condition', 'certificate', 'taxIncluded', 'freightIncluded', 'incoterm'],
    });
    expect(contract.components.schemas.SupplierQuoteComparisonGroup.required).toContain('commercialBasisGroups');
    expect(contract.components.schemas.SupplierQuoteComparisonGroup.properties?.commercialBasisGroups).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/SupplierQuoteCommercialBasisGroup' },
    });
  });

  it('contracts server-owned sourcing AI tasks with idempotent create, retry and cancel states', () => {
    const create = operation('POST', '/api/sourcing-ai-tasks');
    const list = operation('GET', '/api/sourcing-ai-tasks');
    const read = operation('GET', '/api/sourcing-ai-tasks/{id}');
    const retry = operation('POST', '/api/sourcing-ai-tasks/{id}/retry');
    const cancel = operation('POST', '/api/sourcing-ai-tasks/{id}/cancel');

    expect(create.requestBody).toEqual(expect.objectContaining({ required: true }));
    expect(create.responses['201']).toEqual({ $ref: '#/components/responses/SourcingAiTask' });
    expect(create.responses['200']).toEqual({ $ref: '#/components/responses/SourcingAiTask' });
    expect(list.responses['200']).toEqual({ $ref: '#/components/responses/SourcingAiTaskList' });
    expect(list.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'emailId', in: 'query', required: false }),
      expect.objectContaining({ name: 'inquiryId', in: 'query', required: false }),
    ]));
    expect(read.responses['200']).toEqual({ $ref: '#/components/responses/SourcingAiTask' });
    expect(retry.responses['200']).toEqual({ $ref: '#/components/responses/SourcingAiTask' });
    expect(cancel.responses['200']).toEqual({ $ref: '#/components/responses/SourcingAiTask' });
    expect(contract.components.schemas.SourcingAiTask.required).toEqual(expect.arrayContaining([
      'actorId', 'status', 'attempt', 'maxAttempts', 'draftId', 'errorSummary',
    ]));
    expect(contract.components.schemas.SourcingAiTaskCreateRequest.required).toEqual([
      'type', 'emailId', 'inquiryId', 'idempotencyKey',
    ]);
  });

  it('contracts audit administration, API key secrecy, feature flags and IPC reference reads', () => {
    const auditList = operation('GET', '/api/audit-logs');
    const auditCreate = operation('POST', '/api/audit-logs');
    const auditStats = operation('GET', '/api/audit-logs/stats');
    const apiKeyList = operation('GET', '/api/api-keys');
    const apiKeyCreate = operation('POST', '/api/api-keys');
    const apiKeyUpdate = operation('PUT', '/api/api-keys/{id}');
    const featureList = operation('GET', '/api/features');
    const ipcSearch = operation('GET', '/api/ipc/search');
    const ipcCompatibility = operation('GET', '/api/ipc/compatibility');
    const ipcDetail = operation('GET', '/api/ipc/{partNumber}');

    expect(auditList.responses['200']).toEqual({ $ref: '#/components/responses/AuditLogList' });
    expect(auditList.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'startDate', in: 'query', schema: expect.objectContaining({ format: 'date-time' }) }),
      expect.objectContaining({ name: 'status', in: 'query', schema: expect.objectContaining({ enum: ['SUCCESS', 'FAILURE'] }) }),
    ]));
    expect(auditCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/AuditLogCreate' });
    expect(auditCreate.responses['201']).toEqual({ $ref: '#/components/responses/AuditLog' });
    expect(auditStats.responses['200']).toEqual({ $ref: '#/components/responses/AuditLogStats' });

    expect(apiKeyList.responses['200']).toEqual({ $ref: '#/components/responses/ApiKeyList' });
    expect(apiKeyCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/ApiKeyCreate' });
    expect(apiKeyCreate.responses['200']).toEqual({ $ref: '#/components/responses/ApiKeyCreate' });
    expect(apiKeyUpdate.requestBody).toEqual({ $ref: '#/components/requestBodies/ApiKeyUpdate' });
    expect(contract.components.schemas.ApiKeyCreate.properties).toMatchObject({ key: { writeOnly: true } });

    expect(featureList.responses['200']).toEqual({ $ref: '#/components/responses/FeatureList' });
    expect(ipcSearch.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'q', in: 'query', required: true }),
    ]));
    expect(ipcCompatibility.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'partNumber', in: 'query', required: true }),
      expect.objectContaining({ name: 'aircraftType', in: 'query', required: true }),
    ]));
    expect(ipcDetail.responses['200']).toEqual({ $ref: '#/components/responses/Ipc' });
  });

  it('contracts bounded pricing and inventory analytics projections', () => {
    const recommendation = operation('GET', '/api/pricing/recommendation');
    const batch = operation('POST', '/api/pricing/recommendations/batch');
    const history = operation('GET', '/api/pricing/history/{partNumber}');
    const pricingBi = operation('GET', '/api/pricing-bi/summary');
    const consumption = operation('GET', '/api/inventory-analytics/consumption-trend');
    const safetyStock = operation('GET', '/api/inventory-analytics/safety-stock');
    const health = operation('GET', '/api/inventory-analytics/health-summary');
    const seasonal = operation('GET', '/api/inventory-analytics/seasonal-forecast/{partNumber}');

    expect(recommendation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'partNumber', in: 'query', required: true }),
      expect.objectContaining({ name: 'quantity', in: 'query', required: true }),
    ]));
    expect(recommendation.responses['200']).toEqual({ $ref: '#/components/responses/PriceRecommendation' });
    expect(batch.requestBody).toEqual({ $ref: '#/components/requestBodies/PriceRecommendationBatch' });
    expect(history.responses['200']).toEqual({ $ref: '#/components/responses/PriceHistory' });
    expect(pricingBi.responses['200']).toEqual({ $ref: '#/components/responses/PricingBiSummary' });
    expect(consumption.responses['200']).toEqual({ $ref: '#/components/responses/ConsumptionTrendList' });
    expect(safetyStock.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'leadTimeDays', in: 'query', schema: expect.objectContaining({ minimum: 1 }) }),
    ]));
    expect(health.responses['200']).toEqual({ $ref: '#/components/responses/InventoryHealthSummary' });
    expect(seasonal.responses['200']).toEqual({ $ref: '#/components/responses/SeasonalForecast' });
    expect(contract.components.schemas.PriceAvailability.properties).toMatchObject({
      status: { enum: ['available', 'insufficient_data', 'unavailable', 'disabled'] },
    });
  });

  it('contracts valuation, consignment and exchange/VMI projections with bounded DTOs', () => {
    const consignmentList = operation('GET', '/api/consignments');
    const consignmentCreate = operation('POST', '/api/consignments');
    const alerts = operation('GET', '/api/consignments/alerts');
    const fmv = operation('GET', '/api/fmv/{partNumber}');
    const fmvHistory = operation('GET', '/api/fmv/{partNumber}/history');
    const fmvBatch = operation('POST', '/api/fmv/batch');
    const exchanges = operation('GET', '/api/exchange-vmi/exchanges');
    const vmi = operation('GET', '/api/exchange-vmi/vmi-agreements');
    const restock = operation('GET', '/api/exchange-vmi/restock-suggestions');
    const stats = operation('GET', '/api/exchange-vmi/stats');

    expect(consignmentList.responses['200']).toEqual({ $ref: '#/components/responses/ConsignmentList' });
    expect(consignmentCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/ConsignmentCreate' });
    expect(alerts.responses['200']).toEqual({ $ref: '#/components/responses/ConsignmentAlerts' });
    expect(contract.components.schemas.Consignment.required).toEqual(expect.arrayContaining(['agreementNumber', 'supplierId', 'partNumber', 'currentQuantity']));
    expect(fmv.responses['200']).toEqual({ $ref: '#/components/responses/Fmv' });
    expect(fmv.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'conditionCode', in: 'query' }),
    ]));
    expect(fmvHistory.responses['200']).toEqual({ $ref: '#/components/responses/FmvHistory' });
    expect(fmvBatch.requestBody).toEqual({ $ref: '#/components/requestBodies/FmvBatch' });
    expect(exchanges.responses['200']).toEqual({ $ref: '#/components/responses/ExchangeList' });
    expect(vmi.responses['200']).toEqual({ $ref: '#/components/responses/VmiAgreementList' });
    expect(restock.responses['200']).toEqual({ $ref: '#/components/responses/RestockSuggestionList' });
    expect(stats.responses['200']).toEqual({ $ref: '#/components/responses/ExchangeVmiStats' });
  });

  it('contracts workflow definitions and approval actions without JSON shadow leakage', () => {
    const definitionList = operation('GET', '/api/workflows/definitions');
    const definitionCreate = operation('POST', '/api/workflows/definitions');
    const definitionUpdate = operation('PUT', '/api/workflows/definitions/{id}');
    const duplicate = operation('POST', '/api/workflows/definitions/{id}/duplicate');
    const instanceList = operation('GET', '/api/workflows/instances');
    const instanceCreate = operation('POST', '/api/workflows/instances');
    const approve = operation('POST', '/api/workflows/instances/{id}/approve');
    const transfer = operation('POST', '/api/workflows/instances/{id}/transfer');
    const cancel = operation('POST', '/api/workflows/instances/{id}/cancel');
    const pending = operation('GET', '/api/workflows/instances/pending');
    const byEntity = operation('GET', '/api/workflows/instances/entity/{entityType}/{entityId}');

    expect(definitionList.responses['200']).toEqual({ $ref: '#/components/responses/WorkflowDefinitionList' });
    expect(definitionCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/WorkflowDefinitionCreate' });
    expect(definitionUpdate.requestBody).toEqual({ $ref: '#/components/requestBodies/WorkflowDefinitionUpdate' });
    expect(duplicate.responses['201']).toEqual({ $ref: '#/components/responses/WorkflowDefinition' });
    expect(instanceList.responses['200']).toEqual({ $ref: '#/components/responses/WorkflowInstanceList' });
    expect(instanceCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/WorkflowInstanceCreate' });
    expect(approve.requestBody).toEqual({ $ref: '#/components/requestBodies/WorkflowDecision' });
    expect(transfer.requestBody).toEqual({ $ref: '#/components/requestBodies/WorkflowTransfer' });
    expect(cancel.requestBody).toEqual({ $ref: '#/components/requestBodies/WorkflowCancel' });
    expect(pending.responses['200']).toEqual({ $ref: '#/components/responses/WorkflowPendingList' });
    expect(byEntity.responses['200']).toEqual({ $ref: '#/components/responses/WorkflowInstanceList' });
    expect(contract.components.schemas.WorkflowInstance.properties).not.toHaveProperty('contextJson');
    expect(contract.components.schemas.WorkflowAction.properties).not.toHaveProperty('payloadJson');
  });

  it('contracts email synchronization and internal certificate-integrity operations', () => {
    const sync = operation('POST', '/api/email-sync/sync/{accountId}');
    const mailList = operation('GET', '/api/email-sync/list/{accountId}');
    const classify = operation('POST', '/api/email-sync/classify/{emailId}');
    const store = operation('POST', '/api/blockchain/store/{certificateId}');
    const verify = operation('GET', '/api/blockchain/verify/{certificateId}');
    const chain = operation('GET', '/api/blockchain/chain/verify');
    const stats = operation('GET', '/api/blockchain/stats');
    const records = operation('GET', '/api/blockchain/records');
    const hash = operation('GET', '/api/blockchain/hash/{certificateId}');

    expect(sync.responses['200']).toEqual({ $ref: '#/components/responses/EmailSync' });
    expect(mailList.responses['200']).toEqual({ $ref: '#/components/responses/EmailList' });
    expect(mailList.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'type', in: 'query' }),
      expect.objectContaining({ name: 'isRead', in: 'query' }),
    ]));
    expect(classify.responses['200']).toEqual({ $ref: '#/components/responses/Email' });
    expect(store.responses['200']).toEqual({ $ref: '#/components/responses/BlockchainRecord' });
    expect(verify.responses['200']).toEqual({ $ref: '#/components/responses/BlockchainCertificateVerification' });
    expect(chain.responses['200']).toEqual({ $ref: '#/components/responses/BlockchainChainVerification' });
    expect(stats.responses['200']).toEqual({ $ref: '#/components/responses/BlockchainStats' });
    expect(records.responses['200']).toEqual({ $ref: '#/components/responses/BlockchainRecordList' });
    expect(hash.responses['200']).toEqual({ $ref: '#/components/responses/BlockchainHash' });
    expect(contract.components.schemas.IntegrityMetadata.properties).toMatchObject({ externalTrustAnchor: { const: false } });
  });

  it('contracts agent runtime, agent administration and AI model boundaries', () => {
    const runtimeList = operation('GET', '/api/agents/runtime/tasks');
    const runtimeUpdate = operation('PUT', '/api/agents/runtime/tasks/{id}');
    const runtimeDashboard = operation('GET', '/api/agents/runtime/dashboard');
    const agents = operation('GET', '/api/agents');
    const agentCreate = operation('POST', '/api/agents');
    const agentRun = operation('POST', '/api/agents/{id}/run');
    const agentLogs = operation('GET', '/api/agents/{id}/logs');
    const models = operation('GET', '/api/models');
    const modelCreate = operation('POST', '/api/models');
    const modelTest = operation('POST', '/api/models/{id}/test');
    const modelDefault = operation('POST', '/api/models/{id}/set-default');

    expect(runtimeList.responses['200']).toEqual({ $ref: '#/components/responses/AgentRuntimeTaskList' });
    expect(runtimeUpdate.requestBody).toBeUndefined();
    expect(runtimeUpdate.responses).not.toHaveProperty('200');
    expect(runtimeUpdate.responses).toHaveProperty('410');
    expect(runtimeDashboard.responses['200']).toEqual({ $ref: '#/components/responses/AgentRuntimeDashboard' });
    expect(agents.responses['200']).toEqual({ $ref: '#/components/responses/AgentList' });
    expect(agentCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/AgentCreate' });
    expect(agentRun.requestBody).toEqual({ $ref: '#/components/requestBodies/AgentRun' });
    expect(agentLogs.responses['200']).toEqual({ $ref: '#/components/responses/AgentLogList' });
    expect(models.responses['200']).toEqual({ $ref: '#/components/responses/AiModelList' });
    expect(modelCreate.requestBody).toEqual({ $ref: '#/components/requestBodies/AiModelCreate' });
    expect(modelTest.responses['200']).toEqual({ $ref: '#/components/responses/AiModelTest' });
    expect(modelDefault.responses['200']).toEqual({ $ref: '#/components/responses/AiModel' });
    expect(contract.components.schemas.AiModel.properties).not.toHaveProperty('apiKey');
    expect(contract.components.schemas.AiModelCreateRequest.properties).toMatchObject({ apiKey: { writeOnly: true } });
    expect(contract.components.schemas.AgentRuntimeTask.properties).not.toHaveProperty('contextJson');
  });

  it('requires an exact review snapshot and rejects client-supplied reviewer identity', () => {
    const review = operation('POST', '/api/inventory-transactions/quality-reviews');
    const preview = operation('GET', '/api/inventory-transactions/quality-review/{orderId}');
    expect(review.responses).toHaveProperty('201');
    expect(preview.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'quantity', required: true })]));
    const schema = contract.components.schemas.FulfillmentReviewCreateRequest;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(['snapshotHash', 'quantity', 'checks', 'reason', 'evidenceIds']));
    expect(schema.properties).not.toHaveProperty('reviewedById');
    expect(schema.properties).not.toHaveProperty('reviewedAt');
    const quotationCreate = contract.components.schemas.QuotationCreateRequest;
    expect(quotationCreate.oneOf).toHaveLength(2);
    const quotationBranches = schemaBranches('QuotationCreateRequest');
    const legacy = quotationBranches.find((branch) => branch.properties?.partNumber);
    const modern = quotationBranches.find((branch) => branch.properties?.lines);
    if (!legacy || !modern) {
      throw new Error('QuotationCreateRequest must expose legacy and modern branches');
    }

    // Both accepted request variants are USD-only. The modern branch also
    // pins the value with const so callers cannot omit the mode's currency.
    expect(legacy.properties?.currency).toMatchObject({ enum: ['USD'] });
    expect(modern.properties?.currency).toMatchObject({ enum: ['USD'], const: 'USD' });

    // Legacy requests keep scalar commercial facts and their cost evidence at
    // the top level. A line-first request must carry those facts only inside
    // its required lines array.
    expect(legacy.required).toEqual(expect.arrayContaining([
      'rfqId', 'customerId', 'partNumber', 'quantity', 'unitPrice', 'costPrice', 'costSourceType',
    ]));
    expect(legacy.properties).not.toHaveProperty('lines');
    expect(modern.required).toEqual(expect.arrayContaining(['rfqId', 'customerId', 'currency', 'lines']));
    expect(modern.properties).not.toHaveProperty('partNumber');
    expect(modern.properties).not.toHaveProperty('quantity');
    expect(modern.properties).not.toHaveProperty('unitPrice');
    expect(modern.properties).not.toHaveProperty('costPrice');
    expect(modern.properties).not.toHaveProperty('costSourceType');

    const lineArray = modern.properties?.lines as Schema;
    const line = resolveSchema(lineArray.items as Schema);
    expect(line.required).toEqual(expect.arrayContaining([
      'rfqLineId', 'partNumber', 'quantity', 'unitPrice', 'costPrice', 'costSourceType',
    ]));
    expect(line.properties).toHaveProperty('costSourceType');

    const legacyCostRules = costSourceBranches(legacy);
    const lineCostRules = costSourceBranches(line);
    expect(legacyCostRules).toHaveLength(2);
    expect(lineCostRules).toHaveLength(2);
    for (const rule of [...legacyCostRules, ...lineCostRules]) {
      expect(rule.required).toEqual(expect.arrayContaining(['costSourceType']));
    }
    expect(legacyCostRules.find((rule) => rule.properties?.costSourceType?.const === 'MANUAL')?.required)
      .toEqual(expect.arrayContaining(['costSourceReason']));
    expect(lineCostRules.find((rule) => rule.properties?.costSourceType?.const === 'MANUAL')?.required)
      .toEqual(expect.arrayContaining(['costSourceReason']));
    expect(legacyCostRules.find((rule) => rule.properties?.costSourceType?.enum)?.required)
      .toEqual(expect.arrayContaining(['costSourceId']));
    expect(lineCostRules.find((rule) => rule.properties?.costSourceType?.enum)?.required)
      .toEqual(expect.arrayContaining(['costSourceId']));
  });

  it('contracts commercial quotation revision requests and metadata-only history', () => {
    const revise = operation('POST', '/api/quotations/{id}/revise');
    const revisions = operation('GET', '/api/quotations/{id}/revisions');

    expect(revise['x-aerolink-contract-status']).toBe('contracted');
    expect(revise.requestBody).toEqual({ $ref: '#/components/requestBodies/QuotationRevise' });
    expect(revise.responses['201']).toEqual({ $ref: '#/components/responses/QuotationRevisionCreated' });
    expect(revisions['x-aerolink-contract-status']).toBe('contracted');
    expect(revisions.requestBody).toBeUndefined();
    expect(revisions.responses['200']).toEqual({ $ref: '#/components/responses/QuotationRevisionList' });

    const request = resolveSchema(contract.components.schemas.QuotationReviseRequest);
    expect(request.additionalProperties).toBe(false);
    expect(request.required).toEqual(expect.arrayContaining(['version', 'reason', 'quotation']));
    expect(request.properties?.version).toMatchObject({ type: 'integer', minimum: 1 });
    expect(request.properties?.reason).toMatchObject({ type: 'string', minLength: 1, maxLength: 1000 });
    const nestedQuotation = request.properties?.quotation as Schema;
    expect(nestedQuotation.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ $ref: '#/components/schemas/QuotationCreateRequest' }),
      expect.objectContaining({ required: expect.arrayContaining(['validityDays']) }),
    ]));
    expect(nestedQuotation.allOf?.find((entry) => entry.required?.includes('validityDays'))?.properties?.validityDays)
      .toMatchObject({ type: 'integer', minimum: 1 });

    const quotation = contract.components.schemas.Quotation;
    expect(quotation.properties).toMatchObject({
      commercialRevision: expect.objectContaining({ type: 'integer', minimum: 1 }),
      revisionOfId: expect.objectContaining({ type: ['string', 'null'] }),
      revisionRootId: expect.objectContaining({ type: ['string', 'null'] }),
      revisionReason: expect.objectContaining({ type: ['string', 'null'] }),
      supersededAt: expect.objectContaining({ type: ['string', 'null'], format: 'date-time' }),
      supersededById: expect.objectContaining({ type: 'string' }),
    });
    expect(quotation.required).toContain('commercialRevision');
    expect(quotation.required).not.toContain('supersededById');

    const metadata = resolveSchema(contract.components.schemas.QuotationRevision);
    expect(metadata.required).toEqual(expect.arrayContaining([
      'id', 'quoteNumber', 'commercialRevision', 'revisionOfId', 'revisionRootId',
      'revisionReason', 'supersededAt', 'createdAt', 'status', 'expiryDate',
    ]));
    expect(metadata.required).not.toContain('supersededById');
    expect(metadata.properties?.commercialRevision).toMatchObject({ type: 'integer', minimum: 1 });
    for (const field of ['unitPrice', 'totalPrice', 'costPrice', 'margin', 'costSourceType', 'costSourceId', 'costSourceReason', 'costSourceSnapshotJson']) {
      expect(metadata.properties).not.toHaveProperty(field);
    }

    const created = resolveSchema(contract.components.schemas.QuotationRevisionCreated);
    expect(created.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ $ref: '#/components/schemas/Quotation' }),
      expect.objectContaining({ required: expect.arrayContaining(['previousQuotationId']) }),
    ]));
  });

  it('contracts bounded AI assistance requests and response shapes', () => {
    const parse = operation('POST', '/api/ai/parse-email');
    const analyze = operation('POST', '/api/ai/analyze-quotes');
    const email = operation('POST', '/api/ai/generate-email');
    const chat = operation('POST', '/api/ai/chat');

    expect(parse.requestBody).toEqual({ $ref: '#/components/requestBodies/AiParseEmail' });
    expect(parse.responses['200']).toEqual({ $ref: '#/components/responses/AiParsedEmail' });
    expect(analyze.requestBody).toEqual({ $ref: '#/components/requestBodies/AiAnalyzeQuotes' });
    expect(analyze.responses['200']).toEqual({ $ref: '#/components/responses/AiQuoteAnalysis' });
    expect(email.requestBody).toEqual({ $ref: '#/components/requestBodies/AiGenerateEmail' });
    expect(email.responses['200']).toEqual({ $ref: '#/components/responses/AiGeneratedEmail' });
    expect(chat.requestBody).toEqual({ $ref: '#/components/requestBodies/AiChat' });
    expect(chat.responses['200']).toEqual({ $ref: '#/components/responses/AiCompletion' });
    expect(contract.components.schemas.AiChatRequest.required).toEqual(['message']);
  });

  it('contracts auction and sealed-bid boundaries with explicit action DTOs', () => {
    const list = operation('GET', '/api/auctions');
    const create = operation('POST', '/api/auctions');
    const detail = operation('GET', '/api/auctions/{id}');
    const activate = operation('POST', '/api/auctions/{id}/activate');
    const close = operation('POST', '/api/auctions/{id}/close');
    const bid = operation('POST', '/api/auctions/{id}/bid');
    const bids = operation('GET', '/api/auctions/{id}/bids');
    const active = operation('GET', '/api/auctions/active');
    const mine = operation('GET', '/api/auctions/my-bids');

    expect(list.responses['200']).toEqual({ $ref: '#/components/responses/AuctionList' });
    expect(create.requestBody).toEqual({ $ref: '#/components/requestBodies/AuctionCreate' });
    expect(detail.responses['200']).toEqual({ $ref: '#/components/responses/AuctionDetail' });
    expect(activate.responses['200']).toEqual({ $ref: '#/components/responses/AuctionAction' });
    expect(close.responses['200']).toEqual({ $ref: '#/components/responses/AuctionAction' });
    expect(bid.requestBody).toEqual({ $ref: '#/components/requestBodies/AuctionBidCreate' });
    expect(bid.responses['201']).toEqual({ $ref: '#/components/responses/AuctionBid' });
    expect(bids.responses['200']).toEqual({ $ref: '#/components/responses/AuctionBidList' });
    expect(active.responses['200']).toEqual({ $ref: '#/components/responses/AuctionList' });
    expect(mine.responses['200']).toEqual({ $ref: '#/components/responses/AuctionList' });
    expect(contract.components.schemas.AuctionBidCreateRequest.required).toEqual(['amount']);
    expect(contract.components.schemas.AuctionDetail.properties.bids).toBeDefined();
  });

  it('contracts strict purchase commitment sources, private cost projection and idempotent commands', () => {
    const orderList = operation('GET', '/api/purchase-commitments');
    const detail = operation('GET', '/api/purchase-commitments/{id}');
    const create = operation('POST', '/api/purchase-commitments');
    const transitionPaths = ['submit', 'approve', 'reject', 'cancel'];
    const confirm = operation('POST', '/api/purchase-commitments/{id}/confirm');

    expect(orderList.responses['200']).toEqual({ $ref: '#/components/responses/PurchaseCommitmentOrderList' });
    expect(orderList['x-aerolink-strict-query']).toBe(true);
    expect(orderList.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'orderId', in: 'query', required: true }),
    ]));
    expect(detail.responses['200']).toEqual({ $ref: '#/components/responses/PurchaseCommitment' });
    expect(create.requestBody).toEqual({ $ref: '#/components/requestBodies/PurchaseCommitmentCreate' });
    expect(create.responses['201']).toEqual({ $ref: '#/components/responses/PurchaseCommitment' });
    for (const action of transitionPaths) {
      const transition = operation('POST', `/api/purchase-commitments/{id}/${action}`);
      expect(transition.requestBody).toEqual({ $ref: '#/components/requestBodies/PurchaseCommitmentTransition' });
      expect(transition.responses['200']).toEqual({ $ref: '#/components/responses/PurchaseCommitment' });
      expect(transition.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
    }
    expect(confirm.requestBody).toEqual({ $ref: '#/components/requestBodies/PurchaseCommitmentConfirm' });
    expect(confirm.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));

    const request = resolveSchema(contract.components.schemas.PurchaseCommitmentCreateRequest);
    expect(request.additionalProperties).toBe(false);
    expect(request.required).toEqual(expect.arrayContaining(['orderId', 'supplierId', 'lines']));
    const line = resolveSchema(request.properties?.lines?.items as Schema);
    expect(line.additionalProperties).toBe(false);
    expect(line.required).toEqual(expect.arrayContaining(['orderLineId', 'source', 'quantity', 'promisedDate', 'fulfillmentMode']));
    const source = resolveSchema(line.properties?.source as Schema);
    expect(source.oneOf).toHaveLength(2);
    const sourceBranches = source.oneOf?.map(resolveSchema) ?? [];
    expect(sourceBranches).toEqual(expect.arrayContaining([
      expect.objectContaining({ required: expect.arrayContaining(['type', 'supplierQuoteId']) }),
      expect.objectContaining({ required: expect.arrayContaining(['type', 'unitCost', 'currency', 'reason', 'evidenceFileIds']) }),
    ]));
    const manual = sourceBranches.find((branch) => branch.properties?.type?.const === 'MANUAL');
    expect(manual?.properties?.currency).toMatchObject({ const: 'USD', enum: ['USD'] });
    expect(manual?.additionalProperties).toBe(false);

    const purchase = contract.components.schemas.PurchaseCommitment;
    for (const field of ['currency', 'totalCost', 'paymentTerms', 'supplierReferenceNo', 'approvalSnapshot', 'confirmationEvidence']) {
      expect(purchase.properties?.[field]).toBeDefined();
      expect(JSON.stringify(purchase.properties?.[field])).toContain('purchase_commitment.view_cost');
    }
    const purchaseLine = contract.components.schemas.PurchaseCommitmentLine;
    for (const field of ['currency', 'unitCost', 'lineTotal', 'sourceSupplierQuoteId', 'sourceSnapshot']) {
      expect(JSON.stringify(purchaseLine.properties?.[field])).toContain('purchase_commitment.view_cost');
    }
  });

  it('contracts USD settlement AR/AP projections, immutable records and required idempotency', () => {
    const list = operation('GET', '/api/settlements');
    const detail = operation('GET', '/api/settlements/{id}');
    const create = operation('POST', '/api/settlements');
    const record = operation('POST', '/api/settlements/{id}/records');

    expect(list['x-aerolink-contract-status']).toBe('contracted');
    expect(list.responses['200']).toEqual({ $ref: '#/components/responses/SettlementOrderList' });
    expect(list['x-aerolink-strict-query']).toBe(true);
    expect(list.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'orderId', in: 'query', required: true }),
    ]));
    expect(detail.responses['200']).toEqual({ $ref: '#/components/responses/SettlementAccount' });

    expect(create.requestBody).toEqual({ $ref: '#/components/requestBodies/SettlementCreate' });
    expect(create.responses['201']).toEqual({ $ref: '#/components/responses/SettlementAccount' });
    expect(record.requestBody).toEqual({ $ref: '#/components/requestBodies/SettlementRecord' });
    expect(record.responses['201']).toEqual({ $ref: '#/components/responses/SettlementAccount' });
    for (const write of [create, record]) {
      expect(write.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'Idempotency-Key', in: 'header', required: true,
          schema: expect.objectContaining({ minLength: 1, maxLength: 255 }),
        }),
      ]));
      for (const status of ['400', '401', '403', '404', '409', '422', '429', '500']) {
        expect(write.responses[status]).toEqual({ $ref: '#/components/responses/Error' });
      }
    }

    const createRequest = contract.components.schemas.SettlementCreateRequest;
    const createBranches = createRequest.oneOf?.map(resolveSchema) ?? [];
    expect(createBranches).toHaveLength(2);
    const receivable = createBranches.find((branch) => branch.properties?.side?.const === 'RECEIVABLE');
    const payable = createBranches.find((branch) => branch.properties?.side?.const === 'PAYABLE');
    expect(receivable).toBeDefined();
    expect(payable).toBeDefined();
    expect(receivable?.required).toEqual(expect.arrayContaining(['side', 'orderId', 'evidenceIds']));
    expect(receivable?.required).not.toContain('purchaseCommitmentId');
    expect(receivable?.properties?.purchaseCommitmentId).toBe(false);
    expect(payable?.required).toEqual(expect.arrayContaining(['side', 'orderId', 'purchaseCommitmentId']));
    expect(JSON.stringify(payable)).toContain('settlement.view_cost');
    expect(receivable?.properties).not.toHaveProperty('initialAmount');

    const recordRequest = contract.components.schemas.SettlementRecordRequest;
    const recordBranches = recordRequest.oneOf?.map(resolveSchema) ?? [];
    expect(recordBranches).toHaveLength(3);
    const amountRecord = recordBranches.find((branch) => branch.properties?.kind?.enum?.includes('PAYMENT'));
    const reversalRecord = recordBranches.find((branch) => branch.properties?.kind?.const === 'REVERSAL');
    const termsRecord = recordBranches.find((branch) => branch.properties?.kind?.const === 'TERMS');
    expect(amountRecord?.required).toEqual(expect.arrayContaining(['version', 'kind', 'amount', 'evidenceIds']));
    expect(amountRecord?.required).not.toContain('reversalOfId');
    expect(amountRecord?.required).not.toContain('dueDate');
    expect(reversalRecord?.required).toEqual(expect.arrayContaining(['version', 'kind', 'reversalOfId']));
    expect(reversalRecord?.required).not.toContain('amount');
    expect(reversalRecord?.required).not.toContain('dueDate');
    expect(termsRecord?.required).toEqual(expect.arrayContaining(['version', 'kind', 'dueDate']));
    expect(termsRecord?.required).not.toContain('amount');
    expect(termsRecord?.required).not.toContain('reversalOfId');
    expect(amountRecord?.properties?.amount?.pattern).toBeDefined();
    const positiveAmountPattern = new RegExp(amountRecord?.properties?.amount?.pattern as string);
    expect(positiveAmountPattern.test('0.0001')).toBe(true);
    expect(positiveAmountPattern.test('0')).toBe(false);
    expect(positiveAmountPattern.test('0.0000')).toBe(false);
    expect(recordRequest.description).toContain('Append-only');

    const account = contract.components.schemas.SettlementAccount;
    const accountBranches = account.oneOf?.map(resolveSchema) ?? [];
    expect(accountBranches).toHaveLength(2);
    expect(accountBranches.map((branch) => branch.properties?.side?.const)).toEqual(['RECEIVABLE', 'PAYABLE']);
    const receivableAccount = accountBranches.find((branch) => branch.properties?.side?.const === 'RECEIVABLE');
    expect(receivableAccount?.required).toContain('purchaseCommitmentId');
    expect(receivableAccount?.properties?.purchaseCommitmentId).toEqual(expect.objectContaining({ type: 'null', readOnly: true }));
    const amounts = resolveSchema(contract.components.schemas.SettlementAmounts);
    expect(amounts.required).not.toContain('currency');
    expect(amounts.properties).not.toHaveProperty('currency');
    expect(JSON.stringify(accountBranches.find((branch) => branch.properties?.side?.const === 'PAYABLE')))
      .toContain('settlement.view_cost');
    expect(contract.components.schemas.SettlementRecord.properties?.evidence?.items)
      .toEqual(expect.objectContaining({ properties: expect.objectContaining({ status: { const: 'AVAILABLE' } }) }));
    const listSchema = resolveSchema(contract.components.schemas.SettlementOrderList);
    expect(listSchema.properties?.accounts?.items).toEqual({ $ref: '#/components/schemas/SettlementAccount' });
  });
});
