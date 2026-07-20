import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Operation = {
  requestBody?: unknown;
  security?: unknown;
  parameters?: unknown[];
  responses: Record<string, unknown>;
  'x-aerolink-contract-status'?: string;
};

type Contract = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    requestBodies: Record<string, unknown>;
    responses: Record<string, { headers: Record<string, unknown> }>;
    schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
};

const contract = JSON.parse(
  readFileSync('contracts/openapi/openapi.json', 'utf8'),
) as Contract;

function operation(method: string, routePath: string) {
  return contract.paths[routePath]?.[method.toLowerCase()];
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
      expect(contract.components.schemas[requestSchema].properties).toBeDefined();
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
    expect(contract.components.schemas.SupplierQuoteUpdateRequest.properties).toMatchObject({
      status: { enum: ['pending', 'accepted', 'rejected', 'expired'] },
    });
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
    expect(runtimeUpdate.requestBody).toEqual({ $ref: '#/components/requestBodies/AgentRuntimeTaskSync' });
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
});
