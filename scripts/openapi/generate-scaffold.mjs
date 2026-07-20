import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRouteCatalog } from './route-catalog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputPath = path.join(repoRoot, 'contracts', 'openapi', 'openapi.json');

function toOpenApiPath(value) {
  return value.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function tagForPath(value) {
  const part = value.replace(/^\/api\//, '').split('/')[0] || 'system';
  return part.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function operationId(method, routePath) {
  const suffix = routePath
    .replace(/^\/api\//, '')
    .replace(/[^A-Za-z0-9]+(.)?/g, (_match, letter) => letter ? letter.toUpperCase() : '')
    .replace(/^./, (letter) => letter.toUpperCase()) || 'Root';
  return `${method.toLowerCase()}${suffix}`;
}

function securityForPath(routePath) {
  if (routePath === '/api/health') return [];
  if (/^\/api\/auth\/(login|activation|forgot-password|reset-password|reset(?:\/|$))/.test(routePath)) return [];
  if (routePath === '/api/auth/refresh') return [{ refreshCookie: [] }];
  if (routePath === '/api/auth/logout') return [{ refreshCookie: [] }];
  if (routePath.startsWith('/api/v1/')) return [{ apiKeyAuth: [] }];
  if (routePath.startsWith('/api/inbound-webhooks/')) return [{ inboundWebhookSignature: [] }];
  return [{ bearerAuth: [] }];
}

function pathParameters(routePath) {
  return [...routePath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

const paginatedListPaths = new Set([
  '/api/rfqs',
  '/api/quotations',
  '/api/orders',
  '/api/inventory',
  '/api/customers',
  '/api/suppliers',
]);

function parametersFor(endpoint, openApiPath) {
  const parameters = pathParameters(openApiPath);
  if (endpoint.method === 'GET' && paginatedListPaths.has(endpoint.path)) {
    parameters.push(
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      { name: 'search', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { type: 'string' } },
      { name: 'direction', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
    );
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method) && !endpoint.path.startsWith('/api/auth/')) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Stable key for retry-safe writes.',
      schema: { type: 'string', minLength: 8, maxLength: 200 },
    });
  }
  if (endpoint.path.startsWith('/api/inbound-webhooks/')) {
    parameters.push({
      name: 'X-Webhook-Signature',
      in: 'header',
      required: true,
      schema: { type: 'string' },
    });
  }
  return parameters;
}

function requestBodyFor(method, routePath) {
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return undefined;
  if (routePath === '/api/auth/login') return { $ref: '#/components/requestBodies/Login' };
  if (routePath.includes('/upload')) {
    return { $ref: '#/components/requestBodies/MultipartUpload' };
  }
  return { $ref: '#/components/requestBodies/JsonBody' };
}

function responsesFor(routePath) {
  if (routePath === '/api/auth/login') return { '200': { $ref: '#/components/responses/AuthLogin' }, ...errorResponses() };
  if (routePath === '/api/auth/refresh') return { '200': { $ref: '#/components/responses/AuthRefresh' }, ...errorResponses() };
  if (routePath === '/api/auth/logout') return { '200': { $ref: '#/components/responses/AuthLogout' }, ...errorResponses() };
  if (/\.(csv)$/.test(routePath)) {
    return { '200': { $ref: '#/components/responses/CsvExport' }, ...errorResponses() };
  }
  if (/\.(pdf)$|\/pdf$/.test(routePath)) {
    return { '200': { $ref: '#/components/responses/PdfDocument' }, ...errorResponses() };
  }
  return { '200': { $ref: '#/components/responses/Success' }, ...errorResponses() };
}

function errorResponses() {
  return Object.fromEntries([400, 401, 403, 404, 409, 422, 429, 500].map((status) => [String(status), { $ref: '#/components/responses/Error' }]));
}

const coreContractRoots = new Set([
  '/api/rfqs',
  '/api/quotations',
  '/api/orders',
  '/api/inventory',
  '/api/customers',
  '/api/suppliers',
]);

function ref(name) {
  return { $ref: `#/components/${name}` };
}

function schemaRef(name) {
  return ref(`schemas/${name}`);
}

function requestBodyRef(name) {
  return ref(`requestBodies/${name}`);
}

function responseRef(name) {
  return ref(`responses/${name}`);
}

function coreRoot(routePath) {
  const match = [...coreContractRoots].find((root) => routePath === root || routePath.startsWith(`${root}/`));
  return match ?? null;
}

function coreResponse(name, status = '200') {
  return { [status]: responseRef(name), ...errorResponses() };
}

function systemOperationContract(endpoint) {
  if (endpoint.path === '/api/health' && endpoint.method === 'GET') {
    return {
      'x-aerolink-contract-status': 'contracted',
      'x-aerolink-deferred-reason': undefined,
      description: 'Public liveness response; contains no infrastructure secrets.',
      responses: coreResponse('Health'),
    };
  }
  if (endpoint.path === '/api/metrics' && endpoint.method === 'GET') {
    return {
      'x-aerolink-contract-status': 'contracted',
      'x-aerolink-deferred-reason': undefined,
      description: 'Capability-protected aggregate request metrics; no payload or credential data is returned.',
      responses: coreResponse('Metrics'),
    };
  }
  if (endpoint.path === '/api/files/:id' && endpoint.method === 'GET') {
    return {
      'x-aerolink-contract-status': 'contracted',
      'x-aerolink-deferred-reason': undefined,
      description: 'Authorized object download. The media type is taken from stored metadata and the body is streamed.',
      responses: coreResponse('FileDownload'),
    };
  }
  return null;
}

function listParametersFor(endpoint, openApiPath) {
  const parameters = parametersFor(endpoint, openApiPath);
  if (endpoint.method !== 'GET') return parameters;

  const exportRoot = endpoint.path.replace(/\/export\.csv$/, '');
  const parameterRoot = coreContractRoots.has(endpoint.path)
    ? endpoint.path
    : coreContractRoots.has(exportRoot)
      ? exportRoot
      : null;
  if (!parameterRoot) return parameters;

  const filterSchemas = {
    '/api/rfqs': [
      { name: 'status', schema: { type: 'string', enum: ['pending', 'sourcing', 'quoting', 'approved', 'sent', 'won', 'lost'] } },
      { name: 'urgency', schema: { type: 'string', enum: ['aog', 'urgent', 'standard'] } },
    ],
    '/api/quotations': [{ name: 'status', schema: { type: 'string' } }],
    '/api/orders': [{ name: 'status', schema: { type: 'string' } }],
    '/api/inventory': [
      { name: 'conditionCode', schema: { type: 'string' } },
      { name: 'certificateType', schema: { type: 'string' } },
      { name: 'type', schema: { type: 'string', enum: ['own', 'in_transit', 'virtual'] } },
      { name: 'partCategory', schema: { type: 'string' } },
      { name: 'location', schema: { type: 'string' } },
    ],
    '/api/customers': [{ name: 'status', schema: { type: 'string', enum: ['active', 'inactive', 'at_risk'] } }],
    '/api/suppliers': [
      { name: 'level', schema: { type: 'string', enum: ['S', 'A', 'B', 'C'] } },
      { name: 'followUpFilter', schema: { type: 'string', enum: ['all', 'with-follow-up', 'waiting_quote', 'quote_promised'] } },
    ],
  }[parameterRoot] ?? [];

  const baseListParameters = [
    { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    { name: 'search', in: 'query', required: false, schema: { type: 'string' } },
    { name: 'sort', in: 'query', required: false, schema: { type: 'string' } },
    { name: 'direction', in: 'query', required: false, schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
  ];

  if (exportRoot === endpoint.path) {
    return [...parameters, ...filterSchemas.map((parameter) => ({ ...parameter, in: 'query', required: false }))];
  }

  if (endpoint.path.endsWith('/export.csv')) {
    return [
      ...parameters,
      ...baseListParameters,
      ...filterSchemas.map((parameter) => ({ ...parameter, in: 'query', required: false })),
      { name: 'scope', in: 'query', required: false, schema: { type: 'string', enum: ['page', 'filtered'], default: 'page' } },
      { name: 'confirm', in: 'query', required: false, schema: { type: 'string', enum: ['full'] } },
      { name: 'maxRows', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 } },
    ];
  }

  return [
    ...parameters,
    ...filterSchemas.map((parameter) => ({ ...parameter, in: 'query', required: false })),
  ];
}

function versionedReadContract(endpoint, openApiPath) {
  if (!endpoint.path.startsWith('/api/v1/')) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted versioned read-only API facade. Responses reuse the existing internal projections without exposing credentials or provider secrets.',
    parameters: pathParameters(openApiPath),
  };
  const listRoots = new Set([
    '/api/v1/rfqs',
    '/api/v1/quotations',
    '/api/v1/orders',
    '/api/v1/inventory',
    '/api/v1/customers',
    '/api/v1/suppliers',
    '/api/v1/certificates',
    '/api/v1/auctions',
  ]);
  if (endpoint.method === 'GET' && listRoots.has(endpoint.path)) {
    operation.parameters.push(
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      { name: 'search', in: 'query', required: false, schema: { type: 'string' } },
    );
  }

  const resourceResponses = {
    '/api/v1/rfqs': ['RfqList', 'Rfq'],
    '/api/v1/quotations': ['QuotationList', 'Quotation'],
    '/api/v1/orders': ['OrderList', 'Order'],
    '/api/v1/inventory': ['InventoryList', 'Inventory'],
    '/api/v1/customers': ['CustomerList', 'Customer'],
    '/api/v1/suppliers': ['SupplierList', 'Supplier'],
    '/api/v1/certificates': ['CertificateList', 'Certificate'],
  };
  const root = Object.keys(resourceResponses).find((candidate) => endpoint.path === candidate || endpoint.path.startsWith(`${candidate}/`));
  if (endpoint.path === '/api/v1/health') {
    operation.responses = coreResponse('Health');
  } else if (endpoint.path === '/api/v1/pricing/recommendation') {
    operation.responses = coreResponse('Success');
  } else if (root) {
    const [listName, detailName] = resourceResponses[root];
    operation.responses = coreResponse(endpoint.path === root ? listName : detailName);
  } else {
    operation.responses = coreResponse('Success');
  }
  return operation;
}

function coreOperationContract(endpoint, openApiPath) {
  const root = coreRoot(endpoint.path);
  if (!root) return null;

  const isRoot = endpoint.path === root;
  const isDetail = /^\/api\/(rfqs|quotations|orders|inventory|customers|suppliers)\/:id$/.test(endpoint.path);
  const isCreate = isRoot && endpoint.method === 'POST';
  const isUpdate = isDetail && endpoint.method === 'PATCH';
  const isList = isRoot && endpoint.method === 'GET';
  const isDetailRead = isDetail && endpoint.method === 'GET';

  const domain = root.slice('/api/'.length);
  const resourceName = {
    rfqs: 'Rfq',
    quotations: 'Quotation',
    orders: 'Order',
    inventory: 'Inventory',
    customers: 'Customer',
    suppliers: 'Supplier',
  }[domain];
  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: `Contracted core ${domain} operation. DTOs mirror the existing validation and response projection; changes require updating this source and its contract tests.`,
    parameters: listParametersFor(endpoint, openApiPath),
  };

  if (isList) operation.responses = coreResponse(`${resourceName}List`);
  if (isDetailRead) operation.responses = coreResponse(resourceName);
  if (isCreate) {
    operation.requestBody = requestBodyRef(`${resourceName}Create`);
    operation.responses = coreResponse(resourceName, '201');
  }
  if (isUpdate) {
    operation.requestBody = requestBodyRef(`${resourceName}Update`);
    operation.responses = coreResponse(resourceName);
  }

  if (endpoint.path === '/api/rfqs/:id/status' && endpoint.method === 'PATCH') {
    operation.requestBody = requestBodyRef('RfqStatusUpdate');
    operation.responses = coreResponse('Rfq');
  }
  if (endpoint.path === '/api/quotations/:id/status-history' && endpoint.method === 'GET') {
    operation.responses = coreResponse('StatusHistory');
  }
  if (endpoint.path === '/api/orders/:id/status' && endpoint.method === 'PATCH') {
    operation.requestBody = requestBodyRef('OrderStatusUpdate');
    operation.responses = coreResponse('Order');
  }

  if (endpoint.method === 'GET' && /\/export\.csv$/.test(endpoint.path)) {
    operation.responses = coreResponse('CsvExport');
  }
  if (endpoint.method === 'GET' && /\/pdf$/.test(endpoint.path)) {
    operation.responses = coreResponse('PdfDocument');
  }
  if (endpoint.method === 'GET' && /\/status-history$/.test(endpoint.path)) {
    operation.responses = coreResponse('StatusHistory');
  }
  if (endpoint.method === 'DELETE' && isDetail) {
    operation.responses = coreResponse('Success');
  }
  if (endpoint.path === '/api/inventory/reconciliation' && endpoint.method === 'GET') {
    operation.responses = coreResponse('InventoryReconciliation');
  }
  if (endpoint.path === '/api/inventory/part/:partNumber' && endpoint.method === 'GET') {
    operation.responses = coreResponse('InventoryArray');
  }
  if (endpoint.path === '/api/orders/:id/tracking' && endpoint.method === 'GET') {
    operation.responses = coreResponse('Tracking');
  }
  if (endpoint.path === '/api/quotations/:id/submit' && endpoint.method === 'POST') {
    operation.requestBody = requestBodyRef('QuotationTransition');
    operation.responses = coreResponse('Action');
  }
  if (endpoint.path === '/api/quotations/:id/approve' && endpoint.method === 'POST') {
    operation.requestBody = requestBodyRef('QuotationApprove');
    operation.responses = coreResponse('Action');
  }
  if (endpoint.path === '/api/quotations/:id/send' && endpoint.method === 'POST') {
    operation.requestBody = requestBodyRef('QuotationSend');
    operation.responses = coreResponse('Action');
  }
  if (endpoint.path === '/api/quotations/:id/withdraw' && endpoint.method === 'POST') {
    operation.requestBody = requestBodyRef('QuotationWithdraw');
    operation.responses = coreResponse('Action');
  }
  if (endpoint.path === '/api/quotations/:id/accept' && endpoint.method === 'POST') {
    operation.requestBody = requestBodyRef('QuotationAccept');
    operation.responses = coreResponse('Action');
  }

  if (!operation.responses) return null;
  return operation;
}

function authOperationContract(endpoint, openApiPath) {
  if (!endpoint.path.startsWith('/api/auth/')) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted authentication/session operation. Tokens remain in the HttpOnly refresh cookie or in-memory access-token boundary.',
    parameters: pathParameters(openApiPath),
  };
  const authResponses = (name, status = '200') => coreResponse(name, status);

  switch (`${endpoint.method} ${endpoint.path}`) {
    case 'POST /api/auth/login':
      operation.requestBody = requestBodyRef('Login');
      operation.responses = authResponses('AuthLogin');
      break;
    case 'POST /api/auth/refresh':
      operation.responses = authResponses('AuthRefresh');
      break;
    case 'POST /api/auth/logout':
      operation.responses = authResponses('AuthLogout');
      break;
    case 'GET /api/auth/me':
    case 'PUT /api/auth/me':
      if (endpoint.method === 'PUT') operation.requestBody = requestBodyRef('ProfileUpdate');
      operation.responses = authResponses('User');
      break;
    case 'GET /api/auth/capabilities':
      operation.responses = authResponses('Capabilities');
      break;
    case 'GET /api/auth/sessions':
      operation.responses = authResponses('Sessions');
      break;
    case 'POST /api/auth/sessions/revoke-all':
      operation.responses = authResponses('SessionRevokeAll');
      break;
    case 'POST /api/auth/sessions/:id/revoke':
      operation.responses = authResponses('SessionRevoke');
      break;
    case 'GET /api/auth/security-events':
      operation.responses = authResponses('SecurityEvents');
      operation.parameters.push(
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
        { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['OPEN', 'RESOLVED'] } },
      );
      break;
    case 'POST /api/auth/security-events/:id/acknowledge':
      operation.responses = authResponses('SecurityEvent');
      break;
    case 'GET /api/auth/activation/:token':
      operation.responses = authResponses('ActivationInfo');
      break;
    case 'POST /api/auth/activate':
      operation.requestBody = requestBodyRef('TokenPassword');
      operation.responses = authResponses('AuthLogin');
      break;
    case 'POST /api/auth/forgot-password':
      operation.requestBody = requestBodyRef('ForgotPassword');
      operation.responses = authResponses('Message');
      break;
    case 'GET /api/auth/reset/:token':
      operation.responses = authResponses('ResetInfo');
      break;
    case 'POST /api/auth/reset-password':
      operation.requestBody = requestBodyRef('TokenPassword');
      operation.responses = authResponses('AuthLogin');
      break;
    case 'POST /api/auth/change-password':
      operation.requestBody = requestBodyRef('ChangePassword');
      operation.responses = authResponses('Message');
      break;
    default:
      return null;
  }
  return operation;
}

const integrationRoots = [
  '/api/webhooks/phase2',
  '/api/document-templates',
  '/api/documents',
  '/api/certificate-templates',
  '/api/certificates',
  '/api/webhooks',
  '/api/inbound-webhooks',
  '/api/outbox',
];

function integrationQueryParameters(endpoint) {
  const parameters = pathParameters(toOpenApiPath(endpoint.path));
  const path = endpoint.path;
  const add = (name, schema) => parameters.push({ name, in: 'query', required: false, schema });

  if (path.startsWith('/api/inbound-webhooks/')) {
    parameters.push({
      name: 'X-Webhook-Signature',
      in: 'header',
      required: true,
      description: 'HMAC signature. The legacy X-Signature header remains accepted for compatibility.',
      schema: { type: 'string' },
    });
  }

  if (path === '/api/document-templates') add('documentType', { type: 'string' });
  if (path === '/api/documents') {
    add('quotationId', { type: 'string' });
    add('orderId', { type: 'string' });
    add('documentType', { type: 'string' });
  }
  if (path.startsWith('/api/certificate-templates')) {
    add('page', { type: 'integer', minimum: 1, default: 1 });
    add('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 });
    if (path === '/api/certificate-templates') {
      add('certificateType', { type: 'string' });
      add('isActive', { type: 'boolean' });
    }
  }
  if (path.startsWith('/api/certificates')) {
    if (path === '/api/certificates') {
      add('status', { type: 'string' });
      add('certificateType', { type: 'string' });
      add('partNumber', { type: 'string' });
      add('inventoryId', { type: 'string' });
      add('inventoryDetailId', { type: 'string' });
      add('orderId', { type: 'string' });
      add('page', { type: 'integer', minimum: 1, default: 1 });
      add('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 });
    }
    if (path === '/api/certificates/expiring') add('days', { type: 'integer', minimum: 1, maximum: 365, default: 30 });
  }
  if (path.startsWith('/api/webhooks/')) {
    if (path.endsWith('/deliveries') || path === '/api/webhooks/phase2/dlq' || path === '/api/webhooks/phase2/replay' || path.endsWith('/audit')) {
      add('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 });
      add('offset', { type: 'integer', minimum: 0, default: 0 });
    }
    if (path === '/api/webhooks/phase2/dlq') {
      add('endpointId', { type: 'string' });
      add('failureReason', { type: 'string' });
    }
    if (path === '/api/webhooks/phase2/replay') add('status', { type: 'string' });
    if (path === '/api/webhooks/phase2/audit') {
      add('action', { type: 'string' });
      add('resourceType', { type: 'string' });
    }
  }
  if (path === '/api/inbound-webhooks/deliveries' || path === '/api/inbound-webhooks/audit') {
    add('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 });
    add('offset', { type: 'integer', minimum: 0, default: 0 });
    add('endpointId', { type: 'string' });
    add('status', { type: 'string' });
    if (path.endsWith('/audit')) {
      add('action', { type: 'string' });
      add('resourceType', { type: 'string' });
      add('startDate', { type: 'string', format: 'date-time' });
      add('endDate', { type: 'string', format: 'date-time' });
    }
  }
  if (path === '/api/outbox') {
    add('page', { type: 'integer', minimum: 1, default: 1 });
    add('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 });
    add('status', { type: 'string' });
    add('channel', { type: 'string' });
  }
  return parameters;
}

function integrationOperationContract(endpoint, openApiPath) {
  const root = integrationRoots.find((candidate) => endpoint.path === candidate || endpoint.path.startsWith(`${candidate}/`));
  if (!root) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted certificate/document/integration operation. Payloads are bounded to internal metadata and operational controls; secrets and full webhook payloads are never documented as examples.',
    parameters: integrationQueryParameters(endpoint),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const path = endpoint.path;
  const key = `${endpoint.method} ${path}`;

  switch (key) {
    case 'GET /api/document-templates': operation.responses = response('DocumentTemplateList'); break;
    case 'GET /api/document-templates/:id': operation.responses = response('DocumentTemplate'); break;
    case 'POST /api/document-templates': operation.requestBody = requestBodyRef('DocumentTemplateCreate'); operation.responses = response('DocumentTemplate', '201'); break;
    case 'PUT /api/document-templates/:id': operation.requestBody = requestBodyRef('DocumentTemplateUpdate'); operation.responses = response('DocumentTemplate'); break;
    case 'GET /api/documents': operation.responses = response('GeneratedDocumentList'); break;
    case 'GET /api/documents/:id': operation.responses = response('GeneratedDocument'); break;
    case 'GET /api/documents/:id/pdf': operation.responses = response('PdfDocument'); break;
    case 'GET /api/certificate-templates': operation.responses = response('CertificateTemplateList'); break;
    case 'GET /api/certificate-templates/:id': operation.responses = response('CertificateTemplate'); break;
    case 'POST /api/certificate-templates': operation.requestBody = requestBodyRef('CertificateTemplateCreate'); operation.responses = response('CertificateTemplate', '201'); break;
    case 'PUT /api/certificate-templates/:id': operation.requestBody = requestBodyRef('CertificateTemplateUpdate'); operation.responses = response('CertificateTemplate'); break;
    case 'DELETE /api/certificate-templates/:id': operation.responses = response('Success'); break;
    case 'POST /api/certificate-templates/:id/duplicate': operation.responses = response('CertificateTemplate', '201'); break;
    case 'GET /api/certificates': operation.responses = response('CertificateList'); break;
    case 'GET /api/certificates/:id': operation.responses = response('Certificate'); break;
    case 'POST /api/certificates/issue': operation.requestBody = requestBodyRef('CertificateIssue'); operation.responses = response('Certificate', '201'); break;
    case 'POST /api/certificates/:id/verify': operation.responses = response('CertificateVerification'); break;
    case 'POST /api/certificates/:id/revoke': operation.requestBody = requestBodyRef('CertificateRevoke'); operation.responses = response('CertificateAction'); break;
    case 'POST /api/certificates/:id/renew': operation.requestBody = requestBodyRef('CertificateRenew'); operation.responses = response('CertificateAction'); break;
    case 'GET /api/certificates/:id/download': operation.responses = response('CertificateDownload'); break;
    case 'GET /api/certificates/expiring': operation.responses = response('CertificateExpiring'); break;
    case 'GET /api/webhooks/events': operation.responses = response('WebhookEvents'); break;
    case 'GET /api/webhooks/endpoints': operation.responses = response('WebhookEndpointList'); break;
    case 'POST /api/webhooks/endpoints': operation.requestBody = requestBodyRef('WebhookEndpointCreate'); operation.responses = response('WebhookEndpoint', '201'); break;
    case 'GET /api/webhooks/endpoints/:id': operation.responses = response('WebhookEndpoint'); break;
    case 'PATCH /api/webhooks/endpoints/:id': operation.requestBody = requestBodyRef('WebhookEndpointUpdate'); operation.responses = response('WebhookEndpoint'); break;
    case 'DELETE /api/webhooks/endpoints/:id': operation.responses = response('Success'); break;
    case 'GET /api/webhooks/endpoints/:id/subscriptions': operation.responses = response('WebhookSubscriptionList'); break;
    case 'PUT /api/webhooks/endpoints/:id/subscriptions': operation.requestBody = requestBodyRef('WebhookSubscriptionReplace'); operation.responses = response('WebhookSubscriptionList'); break;
    case 'POST /api/webhooks/endpoints/:id/test': operation.responses = response('WebhookDelivery'); break;
    case 'GET /api/webhooks/endpoints/:id/deliveries': operation.responses = response('WebhookDeliveryList'); break;
    case 'POST /api/webhooks/deliveries/:id/retry': operation.responses = response('WebhookDelivery'); break;
    case 'GET /api/inbound-webhooks/endpoints': operation.responses = response('InboundEndpointList'); break;
    case 'POST /api/inbound-webhooks/endpoints': operation.requestBody = requestBodyRef('InboundEndpointCreate'); operation.responses = response('InboundEndpoint', '201'); break;
    case 'GET /api/inbound-webhooks/endpoints/:id': operation.responses = response('InboundEndpoint'); break;
    case 'PATCH /api/inbound-webhooks/endpoints/:id': operation.requestBody = requestBodyRef('InboundEndpointUpdate'); operation.responses = response('InboundEndpoint'); break;
    case 'POST /api/inbound-webhooks/endpoints/:id/disable': operation.responses = response('InboundEndpoint'); break;
    case 'POST /api/inbound-webhooks/endpoints/:id/enable': operation.responses = response('InboundEndpoint'); break;
    case 'DELETE /api/inbound-webhooks/endpoints/:id': operation.responses = response('Success'); break;
    case 'GET /api/inbound-webhooks/deliveries': operation.responses = response('InboundDeliveryList'); break;
    case 'GET /api/inbound-webhooks/audit': operation.responses = response('WebhookAuditList'); break;
    case 'POST /api/inbound-webhooks/:urlPath': operation.requestBody = requestBodyRef('JsonBody'); operation.responses = response('InboundAccepted', '202'); break;
    case 'GET /api/outbox': operation.responses = response('OutboxList'); break;
    case 'GET /api/outbox/stats': operation.responses = response('OutboxStats'); break;
    case 'POST /api/outbox/:id/retry': operation.requestBody = requestBodyRef('OutboxReplay'); operation.responses = response('OutboxEvent'); break;
    case 'POST /api/outbox/:id/cancel': operation.requestBody = requestBodyRef('OutboxCancel'); operation.responses = response('OutboxAction'); break;
    default:
      if (root === '/api/webhooks/phase2') {
        operation.responses = response('WebhookPhase2');
        if (endpoint.method === 'POST') operation.requestBody = requestBodyRef('WebhookPhase2Request');
      } else {
        return null;
      }
  }
  return operation;
}

function reportingOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isDashboard = path.startsWith('/api/dashboard/');
  const isNotifications = path === '/api/notifications' || path.startsWith('/api/notifications/');
  const isReports = path.startsWith('/api/reports/');
  const isUpload = path === '/api/upload' || path === '/api/upload/multiple';
  const isInventoryItems = path === '/api/inventory-items' || path.startsWith('/api/inventory-items/');
  const isInventoryTransactions = path.startsWith('/api/inventory-transactions/');
  if (!isDashboard && !isNotifications && !isReports && !isUpload && !isInventoryItems && !isInventoryTransactions) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal reporting, notification, inventory-canonical or file-ingestion operation. Values are bounded to existing server projections; secrets and file bytes are never represented in examples.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  switch (key) {
    case 'GET /api/dashboard/stats': operation.responses = response('DashboardStats'); break;
    case 'GET /api/dashboard/funnel': operation.responses = response('DashboardFunnel'); break;
    case 'GET /api/dashboard/activities': operation.responses = response('DashboardActivities'); break;
    case 'GET /api/notifications': operation.requestBody = undefined; operation.responses = response('NotificationList'); break;
    case 'GET /api/notifications/unread-count': operation.requestBody = undefined; operation.responses = response('NotificationUnreadCount'); break;
    case 'PATCH /api/notifications/:id/read': operation.requestBody = undefined; operation.responses = response('NotificationAction'); break;
    case 'PATCH /api/notifications/read-all': operation.requestBody = undefined; operation.responses = response('NotificationAction'); break;
    case 'POST /api/notifications/dispatch': operation.requestBody = requestBodyRef('NotificationDispatch'); operation.responses = response('NotificationDispatch'); break;
    case 'GET /api/reports/summary': operation.requestBody = undefined; operation.responses = response('ReportSummary', '200'); break;
    case 'GET /api/reports/sales-trend':
      operation.requestBody = undefined;
      operation.parameters.push({ name: 'months', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 12, default: 6 } });
      operation.responses = response('ReportSalesTrend', '200');
      break;
    case 'GET /api/reports/conversion': operation.requestBody = undefined; operation.responses = response('ReportConversion', '200'); break;
    case 'GET /api/reports/customer-contribution': operation.requestBody = undefined; operation.responses = response('ReportCustomerContribution', '200'); break;
    case 'GET /api/reports/inventory-turnover': operation.requestBody = undefined; operation.responses = response('ReportInventoryTurnover', '200'); break;
    case 'POST /api/upload': operation.responses = response('Upload', '200'); break;
    case 'POST /api/upload/multiple': operation.responses = response('UploadList', '200'); break;
    case 'GET /api/inventory-items':
      operation.requestBody = undefined;
      operation.parameters.push(
        { name: 'partNumber', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'partCategory', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      );
      operation.responses = response('InventoryItemListRaw');
      break;
    case 'GET /api/inventory-items/part/:partNumber': operation.requestBody = undefined; operation.responses = response('InventoryItemRaw'); break;
    case 'GET /api/inventory-items/:id': operation.requestBody = undefined; operation.responses = response('InventoryItemRaw'); break;
    case 'POST /api/inventory-items': operation.requestBody = requestBodyRef('InventoryItemCreate'); operation.responses = response('InventoryItemRaw', '201'); break;
    case 'PATCH /api/inventory-items/:id': operation.requestBody = requestBodyRef('InventoryItemUpdate'); operation.responses = response('InventoryItemRaw'); break;
    case 'GET /api/inventory-transactions/detail/:detailId': operation.requestBody = undefined; operation.responses = response('InventoryTransactionList'); break;
    case 'GET /api/inventory-transactions/order/:orderId': operation.requestBody = undefined; operation.responses = response('InventoryTransactionList'); break;
    case 'POST /api/inventory-transactions/reserve': operation.requestBody = requestBodyRef('InventoryReserve'); operation.responses = response('InventoryTransactionAction', '201'); break;
    case 'POST /api/inventory-transactions/release': operation.requestBody = requestBodyRef('InventoryRelease'); operation.responses = response('InventoryTransactionAction', '201'); break;
    case 'POST /api/inventory-transactions/outbound': operation.requestBody = requestBodyRef('InventoryOutbound'); operation.responses = response('InventoryTransactionAction', '201'); break;
    default: return null;
  }

  return operation;
}

function supportingOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isShipment = path.startsWith('/api/shipment-tracking');
  const isInquiry = path === '/api/inquiries' || path.startsWith('/api/inquiries/');
  const isPreference = path === '/api/notification-preferences/mine';
  const isChannel = path === '/api/channel-bindings' || path.startsWith('/api/channel-bindings/');
  const isPush = path.startsWith('/api/push/');
  if (!isShipment && !isInquiry && !isPreference && !isChannel && !isPush) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted supporting operational operation. Responses mirror the existing internal route projection and exclude credentials or external-provider secrets.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  switch (key) {
    case 'GET /api/shipment-tracking': operation.requestBody = undefined; operation.responses = response('ShipmentTrackingList'); break;
    case 'GET /api/shipment-tracking/customs-risks': operation.requestBody = undefined; operation.responses = response('ShipmentCustomsRiskList'); break;
    case 'GET /api/shipment-tracking/alerts': operation.requestBody = undefined; operation.responses = response('ShipmentAlertList'); break;
    case 'GET /api/shipment-tracking/order/:orderId': operation.requestBody = undefined; operation.responses = response('ShipmentTracking'); break;
    case 'GET /api/shipment-tracking/:trackingNumber': operation.requestBody = undefined; operation.responses = response('ShipmentTracking'); break;
    case 'GET /api/inquiries': operation.requestBody = undefined; operation.responses = response('InquiryList'); break;
    case 'GET /api/inquiries/:id': operation.requestBody = undefined; operation.responses = response('Inquiry'); break;
    case 'POST /api/inquiries': operation.requestBody = requestBodyRef('InquiryCreate'); operation.responses = response('InquiryList', '201'); break;
    case 'POST /api/inquiries/:id/send': operation.requestBody = undefined; operation.responses = response('Inquiry'); break;
    case 'GET /api/notification-preferences/mine': operation.requestBody = undefined; operation.responses = response('NotificationPreference'); break;
    case 'PUT /api/notification-preferences/mine': operation.requestBody = requestBodyRef('NotificationPreferenceUpdate'); operation.responses = response('NotificationPreference'); break;
    case 'GET /api/channel-bindings/mine': operation.requestBody = undefined; operation.responses = response('ChannelBindingList'); break;
    case 'POST /api/channel-bindings': operation.requestBody = requestBodyRef('ChannelBindingCreate'); operation.responses = response('ChannelBinding', '201'); break;
    case 'PUT /api/channel-bindings/:id': operation.requestBody = requestBodyRef('ChannelBindingUpdate'); operation.responses = response('ChannelBinding'); break;
    case 'DELETE /api/channel-bindings/:id': operation.requestBody = undefined; operation.responses = response('Action'); break;
    case 'GET /api/push/vapid-public-key': operation.requestBody = undefined; operation.responses = response('PushVapid'); break;
    case 'POST /api/push/subscribe': operation.requestBody = requestBodyRef('PushSubscribe'); operation.responses = response('PushAction'); break;
    case 'DELETE /api/push/unsubscribe': operation.requestBody = undefined; operation.responses = response('PushAction'); break;
    case 'GET /api/push/status': operation.requestBody = undefined; operation.responses = response('PushStatus'); break;
    default: return null;
  }
  return operation;
}

function cataloguedOperationContract(endpoint, openApiPath) {
  // Every mounted route is a contract surface. Domain-specific handlers above
  // provide the strict DTOs for the core and integration verticals; the
  // remaining enabled internal routes still receive an explicit, versioned
  // JSON envelope and request boundary so they cannot silently drift.
  return {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    'x-aerolink-contract-level': 'baseline-json-envelope',
    description: `Contracted internal ${endpoint.method} ${endpoint.path} operation. This route uses the bounded JSON envelope while its owning vertical slice is migrated to a DTO-specific schema; credentials and provider secrets are excluded.`,
    parameters: parametersFor(endpoint, openApiPath),
    responses: responsesFor(endpoint.path),
    ...(requestBodyFor(endpoint.method, endpoint.path) ? { requestBody: requestBodyFor(endpoint.method, endpoint.path) } : {}),
  };
}

function identityCommunicationOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isUsers = path === '/api/users' || path.startsWith('/api/users/');
  const isEmails = path === '/api/emails' || path.startsWith('/api/emails/');
  const isEmailAccounts = path === '/api/email-accounts' || path.startsWith('/api/email-accounts/');
  if (!isUsers && !isEmails && !isEmailAccounts) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted identity and mail-management operation. User responses omit credentials and activation secrets; email-account responses never expose auth codes.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  if (key === 'GET /api/users') {
    operation.requestBody = undefined;
    operation.responses = response('ManagedUserList');
    return operation;
  }
  if (key === 'GET /api/users/:id') {
    operation.requestBody = undefined;
    operation.responses = response('ManagedUser');
    return operation;
  }
  if (key === 'POST /api/users') {
    operation.requestBody = requestBodyRef('ManagedUserCreate');
    operation.responses = response('ManagedUserOnboarding', '201');
    return operation;
  }
  if (key === 'PUT /api/users/:id') {
    operation.requestBody = requestBodyRef('ManagedUserUpdate');
    operation.responses = response('ManagedUser');
    return operation;
  }
  if (key === 'DELETE /api/users/:id') {
    operation.requestBody = undefined;
    operation.responses = response('ManagedUserDelete');
    return operation;
  }
  if (key === 'POST /api/users/:id/activation-link') {
    operation.requestBody = undefined;
    operation.responses = response('ManagedUserOnboarding');
    return operation;
  }

  if (key === 'GET /api/emails') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['aog', 'standard', 'inquiry', 'spam'] } },
      { name: 'isRead', in: 'query', required: false, schema: { type: 'boolean' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('EmailList');
    return operation;
  }
  if (key === 'GET /api/emails/:id') {
    operation.requestBody = undefined;
    operation.responses = response('Email');
    return operation;
  }
  if (key === 'PATCH /api/emails/:id/read') {
    operation.requestBody = undefined;
    operation.responses = response('Email');
    return operation;
  }
  if (key === 'PATCH /api/emails/:id/classify') {
    operation.requestBody = requestBodyRef('EmailClassify');
    operation.responses = response('Email');
    return operation;
  }

  if (key === 'GET /api/email-accounts') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('EmailAccountList');
    return operation;
  }
  if (key === 'GET /api/email-accounts/auth-deliveries') {
    operation.requestBody = undefined;
    operation.parameters.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } });
    operation.responses = response('AuthEmailDelivery');
    return operation;
  }
  if (key === 'GET /api/email-accounts/:id') {
    operation.requestBody = undefined;
    operation.responses = response('EmailAccount');
    return operation;
  }
  if (key === 'POST /api/email-accounts') {
    operation.requestBody = requestBodyRef('EmailAccountCreate');
    operation.responses = response('EmailAccount', '201');
    return operation;
  }
  if (key === 'PUT /api/email-accounts/:id') {
    operation.requestBody = requestBodyRef('EmailAccountUpdate');
    operation.responses = response('EmailAccount');
    return operation;
  }
  if (key === 'DELETE /api/email-accounts/:id') {
    operation.requestBody = undefined;
    operation.responses = response('Success');
    return operation;
  }
  if (key === 'POST /api/email-accounts/:id/test') {
    operation.requestBody = undefined;
    operation.responses = response('EmailConnectionTest');
    return operation;
  }
  if (key === 'POST /api/email-accounts/:id/sync') {
    operation.requestBody = undefined;
    operation.responses = response('EmailSync');
    return operation;
  }

  return null;
}

function emailSyncOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isEmailSync = path === '/api/email-sync/sync/:accountId'
    || path === '/api/email-sync/list/:accountId'
    || path === '/api/email-sync/classify/:emailId';
  if (!isEmailSync) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted authenticated email synchronization boundary. Mail credentials and provider secrets are excluded; classification returns the normalized internal email record.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;
  if (key === 'POST /api/email-sync/sync/:accountId') {
    operation.requestBody = undefined;
    operation.responses = response('EmailSync');
    return operation;
  }
  if (key === 'GET /api/email-sync/list/:accountId') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['aog', 'standard', 'inquiry', 'spam'] } },
      { name: 'isRead', in: 'query', required: false, schema: { type: 'boolean' } },
    );
    operation.responses = response('EmailList');
    return operation;
  }
  if (key === 'POST /api/email-sync/classify/:emailId') {
    operation.requestBody = undefined;
    operation.responses = response('Email');
    return operation;
  }
  return null;
}

function blockchainOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  if (!path.startsWith('/api/blockchain/')) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal certificate-integrity projection. Records are linked SHA-256 checks in the business database and are explicitly not an external trust anchor or airworthiness decision.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;
  if (key === 'POST /api/blockchain/store/:certificateId') {
    operation.requestBody = undefined;
    operation.responses = response('BlockchainRecord');
    return operation;
  }
  if (key === 'GET /api/blockchain/verify/:certificateId') {
    operation.requestBody = undefined;
    operation.responses = response('BlockchainCertificateVerification');
    return operation;
  }
  if (key === 'GET /api/blockchain/chain/verify') {
    operation.requestBody = undefined;
    operation.responses = response('BlockchainChainVerification');
    return operation;
  }
  if (key === 'GET /api/blockchain/stats') {
    operation.requestBody = undefined;
    operation.responses = response('BlockchainStats');
    return operation;
  }
  if (key === 'GET /api/blockchain/records') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('BlockchainRecordList');
    return operation;
  }
  if (key === 'GET /api/blockchain/hash/:certificateId') {
    operation.requestBody = undefined;
    operation.responses = response('BlockchainHash');
    return operation;
  }
  return null;
}

function agentAndModelOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isAgent = path === '/api/agents' || path.startsWith('/api/agents/');
  const isModel = path === '/api/models' || path.startsWith('/api/models/');
  if (!isAgent && !isModel) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal agent/model administration and runtime operation. Provider credentials, API keys and persisted JSON shadow columns are excluded from response DTOs.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  if (key === 'GET /api/agents/runtime/tasks') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'running', 'waiting_confirmation', 'completed', 'failed', 'cancelled'] } },
      { name: 'type', in: 'query', required: false, schema: { type: 'string' } },
    );
    operation.responses = response('AgentRuntimeTaskList');
    return operation;
  }
  if (key === 'GET /api/agents/runtime/tasks/:id') {
    operation.requestBody = undefined;
    operation.responses = response('AgentRuntimeTask');
    return operation;
  }
  if (key === 'PUT /api/agents/runtime/tasks/:id') {
    operation.requestBody = requestBodyRef('AgentRuntimeTaskSync');
    operation.responses = response('AgentRuntimeTask');
    return operation;
  }
  if (key === 'GET /api/agents/runtime/dashboard') {
    operation.requestBody = undefined;
    operation.responses = response('AgentRuntimeDashboard');
    return operation;
  }

  if (key === 'GET /api/agents') {
    operation.requestBody = undefined;
    operation.responses = response('AgentList');
    return operation;
  }
  if (key === 'POST /api/agents') {
    operation.requestBody = requestBodyRef('AgentCreate');
    operation.responses = response('Agent', '201');
    return operation;
  }
  if (key === 'GET /api/agents/:id') {
    operation.requestBody = undefined;
    operation.responses = response('Agent');
    return operation;
  }
  if (key === 'PATCH /api/agents/:id') {
    operation.requestBody = requestBodyRef('AgentUpdate');
    operation.responses = response('Agent');
    return operation;
  }
  if (key === 'DELETE /api/agents/:id') {
    operation.requestBody = undefined;
    operation.responses = response('AgentAction');
    return operation;
  }
  if (key === 'POST /api/agents/:id/toggle') {
    operation.requestBody = undefined;
    operation.responses = response('Agent');
    return operation;
  }
  if (key === 'POST /api/agents/:id/run') {
    operation.requestBody = requestBodyRef('AgentRun');
    operation.responses = response('AgentRunResult');
    return operation;
  }
  if (key === 'GET /api/agents/:id/logs') {
    operation.requestBody = undefined;
    operation.parameters.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 } });
    operation.responses = response('AgentLogList');
    return operation;
  }

  if (key === 'GET /api/models') {
    operation.requestBody = undefined;
    operation.responses = response('AiModelList');
    return operation;
  }
  if (key === 'POST /api/models') {
    operation.requestBody = requestBodyRef('AiModelCreate');
    operation.responses = response('AiModel', '201');
    return operation;
  }
  if (key === 'GET /api/models/:id') {
    operation.requestBody = undefined;
    operation.responses = response('AiModel');
    return operation;
  }
  if (key === 'PATCH /api/models/:id') {
    operation.requestBody = requestBodyRef('AiModelUpdate');
    operation.responses = response('AiModel');
    return operation;
  }
  if (key === 'DELETE /api/models/:id') {
    operation.requestBody = undefined;
    operation.responses = response('ModelAction');
    return operation;
  }
  if (key === 'POST /api/models/:id/test') {
    operation.requestBody = undefined;
    operation.responses = response('AiModelTest');
    return operation;
  }
  if (key === 'POST /api/models/:id/set-default') {
    operation.requestBody = undefined;
    operation.responses = response('AiModel');
    return operation;
  }

  return null;
}

function aiOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  if (!path.startsWith('/api/ai/')) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal AI assistance boundary. Inputs and outputs are user-directed assistance only; provider credentials and autonomous business decisions are outside this P2 scope.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;
  if (key === 'POST /api/ai/parse-email') {
    operation.requestBody = requestBodyRef('AiParseEmail');
    operation.responses = response('AiParsedEmail');
    return operation;
  }
  if (key === 'POST /api/ai/analyze-quotes') {
    operation.requestBody = requestBodyRef('AiAnalyzeQuotes');
    operation.responses = response('AiQuoteAnalysis');
    return operation;
  }
  if (key === 'POST /api/ai/generate-email') {
    operation.requestBody = requestBodyRef('AiGenerateEmail');
    operation.responses = response('AiGeneratedEmail');
    return operation;
  }
  if (key === 'POST /api/ai/chat') {
    operation.requestBody = requestBodyRef('AiChat');
    operation.responses = response('AiCompletion');
    return operation;
  }
  return null;
}

function auctionOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  if (path !== '/api/auctions' && !path.startsWith('/api/auctions/')) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal auction and bid operation. Supplier portal, external bidding and autonomous settlement remain outside this P2 boundary; sealed bids are redacted until closure.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;
  if (key === 'GET /api/auctions') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] } },
      { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['SALES', 'REVERSE', 'SEALED'] } },
      { name: 'partNumber', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('AuctionList');
    return operation;
  }
  if (key === 'POST /api/auctions') {
    operation.requestBody = requestBodyRef('AuctionCreate');
    operation.responses = response('Auction', '201');
    return operation;
  }
  if (key === 'GET /api/auctions/:id') {
    operation.requestBody = undefined;
    operation.responses = response('AuctionDetail');
    return operation;
  }
  if (key === 'PUT /api/auctions/:id') {
    operation.requestBody = requestBodyRef('AuctionUpdate');
    operation.responses = response('Auction');
    return operation;
  }
  if (key === 'POST /api/auctions/:id/activate' || key === 'POST /api/auctions/:id/cancel' || key === 'POST /api/auctions/:id/close') {
    operation.requestBody = undefined;
    operation.responses = response('AuctionAction');
    return operation;
  }
  if (key === 'POST /api/auctions/:id/bid') {
    operation.requestBody = requestBodyRef('AuctionBidCreate');
    operation.responses = response('AuctionBid', '201');
    return operation;
  }
  if (key === 'GET /api/auctions/:id/bids') {
    operation.requestBody = undefined;
    operation.responses = response('AuctionBidList');
    return operation;
  }
  if (key === 'GET /api/auctions/active') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'partNumber', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('AuctionList');
    return operation;
  }
  if (key === 'GET /api/auctions/my-bids') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('AuctionList');
    return operation;
  }
  return null;
}

function supplierCommercialOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isSupplierFollowUp = path === '/api/suppliers/follow-up-logs';
  const isSupplierInvite = path === '/api/suppliers/invite';
  const isSupplierQuotes = path === '/api/supplier-quotes' || path.startsWith('/api/supplier-quotes/');
  if (!isSupplierFollowUp && !isSupplierInvite && !isSupplierQuotes) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted supplier follow-up, supplier quote and controlled supplier compatibility operation. Responses expose internal records only; no supplier portal or external invitation is created.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  if (key === 'GET /api/suppliers/follow-up-logs') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'supplierId', in: 'query', required: false, schema: { type: 'string', minLength: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 200 } },
    );
    operation.responses = response('SupplierFollowUpLogList');
    return operation;
  }
  if (key === 'POST /api/suppliers/follow-up-logs') {
    operation.requestBody = requestBodyRef('SupplierFollowUpLogBatchCreate');
    operation.responses = response('SupplierFollowUpLogList', '201');
    return operation;
  }
  if (key === 'POST /api/suppliers/invite') {
    operation.requestBody = undefined;
    operation.description = 'Controlled compatibility endpoint. Supplier portal invitations are explicitly disabled in P2 and this route returns FEATURE_DISABLED.';
    operation.responses = {
      '200': { ...responseRef('Success'), description: 'Reserved compatibility response; the current feature-disabled implementation emits 410 instead.' },
      '410': responseRef('Error'),
      ...errorResponses(),
    };
    return operation;
  }

  if (key === 'GET /api/supplier-quotes') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'rfqId', in: 'query', required: false, schema: { type: 'string', minLength: 1 } },
      { name: 'inquiryId', in: 'query', required: false, schema: { type: 'string', minLength: 1 } },
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'expired'] } },
      { name: 'partNumber', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('SupplierQuoteList');
    return operation;
  }
  if (key === 'POST /api/supplier-quotes') {
    operation.requestBody = requestBodyRef('SupplierQuoteCreate');
    operation.responses = response('SupplierQuote', '201');
    return operation;
  }
  if (key === 'GET /api/supplier-quotes/:id') {
    operation.requestBody = undefined;
    operation.responses = response('SupplierQuoteDetail');
    return operation;
  }
  if (key === 'PUT /api/supplier-quotes/:id') {
    operation.requestBody = requestBodyRef('SupplierQuoteUpdate');
    operation.responses = response('SupplierQuote');
    return operation;
  }
  if (key === 'DELETE /api/supplier-quotes/:id') {
    operation.requestBody = undefined;
    operation.responses = response('SupplierQuoteDelete');
    return operation;
  }
  if (key === 'POST /api/supplier-quotes/compare') {
    operation.requestBody = requestBodyRef('SupplierQuoteCompare');
    operation.responses = response('SupplierQuoteComparison');
    return operation;
  }
  if (key === 'POST /api/supplier-quotes/:id/select-winner') {
    operation.requestBody = undefined;
    operation.responses = response('SupplierQuoteWinner');
    return operation;
  }

  return null;
}

function referenceAndAdministrationOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isAudit = path === '/api/audit-logs' || path.startsWith('/api/audit-logs/');
  const isApiKey = path === '/api/api-keys' || path.startsWith('/api/api-keys/');
  const isIpc = path === '/api/ipc/search' || path === '/api/ipc/compatibility' || path.startsWith('/api/ipc/');
  const isFeatures = path === '/api/features';
  if (!isAudit && !isApiKey && !isIpc && !isFeatures) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal administration, IPC reference and feature-availability operation. API key secrets and audit payloads remain bounded and are never documented as examples.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  if (key === 'GET /api/audit-logs') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'userId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'action', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'resourceType', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'resourceId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['SUCCESS', 'FAILURE'] } },
      { name: 'startDate', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'endDate', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'search', in: 'query', required: false, schema: { type: 'string' } },
    );
    operation.responses = response('AuditLogList');
    return operation;
  }
  if (key === 'POST /api/audit-logs') {
    operation.requestBody = requestBodyRef('AuditLogCreate');
    operation.responses = response('AuditLog', '201');
    return operation;
  }
  if (key === 'GET /api/audit-logs/stats') {
    operation.requestBody = undefined;
    operation.responses = response('AuditLogStats');
    return operation;
  }
  if (key === 'GET /api/audit-logs/:id') {
    operation.requestBody = undefined;
    operation.responses = response('AuditLog');
    return operation;
  }
  if (key === 'GET /api/audit-logs/resource/:type/:id' || key === 'GET /api/audit-logs/user/:id') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('AuditLogList');
    return operation;
  }

  if (key === 'GET /api/api-keys') {
    operation.requestBody = undefined;
    operation.responses = response('ApiKeyList');
    return operation;
  }
  if (key === 'POST /api/api-keys') {
    operation.requestBody = requestBodyRef('ApiKeyCreate');
    operation.responses = response('ApiKeyCreate', '200');
    return operation;
  }
  if (key === 'PUT /api/api-keys/:id') {
    operation.requestBody = requestBodyRef('ApiKeyUpdate');
    operation.responses = response('ApiKey');
    return operation;
  }
  if (key === 'DELETE /api/api-keys/:id') {
    operation.requestBody = undefined;
    operation.responses = response('ApiKeyDelete');
    return operation;
  }

  if (key === 'GET /api/features') {
    operation.requestBody = undefined;
    operation.responses = response('FeatureList');
    return operation;
  }

  if (key === 'GET /api/ipc/search') {
    operation.requestBody = undefined;
    operation.parameters.push({ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1 } });
    operation.responses = response('IpcList');
    return operation;
  }
  if (key === 'GET /api/ipc/compatibility') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'partNumber', in: 'query', required: true, schema: { type: 'string', minLength: 1 } },
      { name: 'aircraftType', in: 'query', required: true, schema: { type: 'string', minLength: 1 } },
      { name: 'msn', in: 'query', required: false, schema: { type: 'string' } },
    );
    operation.responses = response('IpcCompatibility');
    return operation;
  }
  if (key === 'GET /api/ipc/:partNumber') {
    operation.requestBody = undefined;
    operation.responses = response('Ipc');
    return operation;
  }

  return null;
}

function analyticsAndPricingOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isPricing = path === '/api/pricing/recommendation'
    || path === '/api/pricing/recommendations/batch'
    || path.startsWith('/api/pricing/history/')
    || path === '/api/pricing/dashboard';
  const isPricingBi = path.startsWith('/api/pricing-bi/');
  const isInventoryAnalytics = path.startsWith('/api/inventory-analytics/');
  if (!isPricing && !isPricingBi && !isInventoryAnalytics) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal pricing and inventory analytics projection. Results are bounded to internal records/rules, include availability metadata and do not constitute external market data or autonomous decisions.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  if (key === 'GET /api/pricing/recommendation') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'partNumber', in: 'query', required: true, schema: { type: 'string', minLength: 1 } },
      { name: 'quantity', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } },
      { name: 'customerId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'proposedPrice', in: 'query', required: false, schema: { type: 'number', minimum: 0 } },
    );
    operation.responses = response('PriceRecommendation');
    return operation;
  }
  if (key === 'POST /api/pricing/recommendations/batch') {
    operation.requestBody = requestBodyRef('PriceRecommendationBatch');
    operation.responses = response('PriceRecommendationList');
    return operation;
  }
  if (key === 'GET /api/pricing/history/:partNumber') {
    operation.requestBody = undefined;
    operation.responses = response('PriceHistory');
    return operation;
  }
  if (key === 'GET /api/pricing/dashboard') {
    operation.requestBody = undefined;
    operation.responses = response('PriceDashboard');
    return operation;
  }

  if (isPricingBi && endpoint.method === 'GET') {
    operation.requestBody = undefined;
    operation.responses = response(path === '/api/pricing-bi/summary' ? 'PricingBiSummary' : 'PricingBiCollection');
    return operation;
  }

  if (key === 'GET /api/inventory-analytics/consumption-trend') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'partNumber', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'months', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 12 } },
    );
    operation.responses = response('ConsumptionTrendList');
    return operation;
  }
  if (key === 'GET /api/inventory-analytics/safety-stock') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'partNumber', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'leadTimeDays', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 30 } },
    );
    operation.responses = response('SafetyStockList');
    return operation;
  }
  if (key === 'GET /api/inventory-analytics/health-summary') {
    operation.requestBody = undefined;
    operation.responses = response('InventoryHealthSummary');
    return operation;
  }
  if (key === 'GET /api/inventory-analytics/seasonal-forecast/:partNumber') {
    operation.requestBody = undefined;
    operation.responses = response('SeasonalForecast');
    return operation;
  }

  return null;
}

function valuationAndInventoryOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  const isConsignment = path === '/api/consignments' || path.startsWith('/api/consignments/');
  const isFmv = path === '/api/fmv/batch' || path.startsWith('/api/fmv/');
  const isExchangeVmi = path.startsWith('/api/exchange-vmi/');
  if (!isConsignment && !isFmv && !isExchangeVmi) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal valuation, consignment and exchange/VMI projection. Values are derived from AeroLink records and rules; no external marketplace or autonomous settlement is invoked.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  if (key === 'GET /api/consignments') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['ACTIVE', 'EXPIRED', 'TERMINATED', 'SETTLING'] } },
      { name: 'supplierId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'partNumber', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('ConsignmentList');
    return operation;
  }
  if (key === 'POST /api/consignments') {
    operation.requestBody = requestBodyRef('ConsignmentCreate');
    operation.responses = response('Consignment', '200');
    return operation;
  }
  if (key === 'GET /api/consignments/:id') {
    operation.requestBody = undefined;
    operation.responses = response('Consignment');
    return operation;
  }
  if (key === 'PUT /api/consignments/:id') {
    operation.requestBody = requestBodyRef('ConsignmentUpdate');
    operation.responses = response('Consignment');
    return operation;
  }
  if (key === 'POST /api/consignments/:id/consume') {
    operation.requestBody = requestBodyRef('ConsignmentConsume');
    operation.responses = response('Consignment');
    return operation;
  }
  if (key === 'POST /api/consignments/:id/terminate') {
    operation.requestBody = undefined;
    operation.responses = response('Consignment');
    return operation;
  }
  if (key === 'GET /api/consignments/alerts') {
    operation.requestBody = undefined;
    operation.responses = response('ConsignmentAlerts');
    return operation;
  }

  if (key === 'GET /api/fmv/:partNumber') {
    operation.requestBody = undefined;
    operation.parameters.push({ name: 'conditionCode', in: 'query', required: false, schema: { type: 'string', default: 'SV' } });
    operation.responses = response('Fmv');
    return operation;
  }
  if (key === 'GET /api/fmv/:partNumber/history') {
    operation.requestBody = undefined;
    operation.parameters.push({ name: 'months', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 120, default: 12 } });
    operation.responses = response('FmvHistory');
    return operation;
  }
  if (key === 'POST /api/fmv/batch') {
    operation.requestBody = requestBodyRef('FmvBatch');
    operation.responses = response('FmvBatchResult');
    return operation;
  }

  if (key === 'GET /api/exchange-vmi/exchanges') {
    operation.requestBody = undefined;
    operation.responses = response('ExchangeList');
    return operation;
  }
  if (key === 'GET /api/exchange-vmi/vmi-agreements') {
    operation.requestBody = undefined;
    operation.responses = response('VmiAgreementList');
    return operation;
  }
  if (key === 'GET /api/exchange-vmi/restock-suggestions') {
    operation.requestBody = undefined;
    operation.responses = response('RestockSuggestionList');
    return operation;
  }
  if (key === 'GET /api/exchange-vmi/stats') {
    operation.requestBody = undefined;
    operation.responses = response('ExchangeVmiStats');
    return operation;
  }

  return null;
}

function workflowOperationContract(endpoint, openApiPath) {
  const path = endpoint.path;
  if (path !== '/api/workflows/definitions' && !path.startsWith('/api/workflows/definitions/') && path !== '/api/workflows/instances' && !path.startsWith('/api/workflows/instances/')) return null;

  const operation = {
    'x-aerolink-contract-status': 'contracted',
    'x-aerolink-deferred-reason': undefined,
    description: 'Contracted internal workflow definition and approval-instance operation. JSON context and action payloads are exposed only as bounded objects; persisted shadow columns and credentials are not returned.',
    parameters: parametersFor(endpoint, openApiPath),
  };
  const response = (name, status = '200') => coreResponse(name, status);
  const key = `${endpoint.method} ${path}`;

  if (key === 'GET /api/workflows/definitions') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'entityType', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'isActive', in: 'query', required: false, schema: { type: 'boolean' } },
    );
    operation.responses = response('WorkflowDefinitionList');
    return operation;
  }
  if (key === 'POST /api/workflows/definitions') {
    operation.requestBody = requestBodyRef('WorkflowDefinitionCreate');
    operation.responses = response('WorkflowDefinition', '201');
    return operation;
  }
  if (key === 'GET /api/workflows/definitions/:id') {
    operation.requestBody = undefined;
    operation.responses = response('WorkflowDefinition');
    return operation;
  }
  if (key === 'PUT /api/workflows/definitions/:id') {
    operation.requestBody = requestBodyRef('WorkflowDefinitionUpdate');
    operation.responses = response('WorkflowDefinition');
    return operation;
  }
  if (key === 'DELETE /api/workflows/definitions/:id') {
    operation.requestBody = undefined;
    operation.responses = response('WorkflowActionResult');
    return operation;
  }
  if (key === 'POST /api/workflows/definitions/:id/duplicate') {
    operation.requestBody = undefined;
    operation.responses = response('WorkflowDefinition', '201');
    return operation;
  }

  if (key === 'GET /api/workflows/instances') {
    operation.requestBody = undefined;
    operation.parameters.push(
      { name: 'entityType', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'entityId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['RUNNING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'TIMEOUT'] } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    );
    operation.responses = response('WorkflowInstanceList');
    return operation;
  }
  if (key === 'POST /api/workflows/instances') {
    operation.requestBody = requestBodyRef('WorkflowInstanceCreate');
    operation.responses = response('WorkflowInstance', '201');
    return operation;
  }
  if (key === 'GET /api/workflows/instances/:id') {
    operation.requestBody = undefined;
    operation.responses = response('WorkflowInstance');
    return operation;
  }
  if (key === 'POST /api/workflows/instances/:id/approve' || key === 'POST /api/workflows/instances/:id/reject') {
    operation.requestBody = requestBodyRef('WorkflowDecision');
    operation.responses = response('WorkflowInstance');
    return operation;
  }
  if (key === 'POST /api/workflows/instances/:id/transfer') {
    operation.requestBody = requestBodyRef('WorkflowTransfer');
    operation.responses = response('WorkflowInstance');
    return operation;
  }
  if (key === 'POST /api/workflows/instances/:id/cancel') {
    operation.requestBody = requestBodyRef('WorkflowCancel');
    operation.responses = response('WorkflowInstance');
    return operation;
  }
  if (key === 'GET /api/workflows/instances/pending') {
    operation.requestBody = undefined;
    operation.responses = response('WorkflowPendingList');
    return operation;
  }
  if (key === 'GET /api/workflows/instances/entity/:entityType/:entityId') {
    operation.requestBody = undefined;
    operation.responses = response('WorkflowInstanceList');
    return operation;
  }

  return null;
}

function coreRequestSchema(properties, required = []) {
  return { type: 'object', required, properties, additionalProperties: false };
}

function coreResourceSchema(properties, required = []) {
  return { type: 'object', required, properties, additionalProperties: true };
}

function moneySchema() {
  return {
    oneOf: [{ type: 'number' }, { type: 'string' }],
    description: '金额兼容表示：当前 API 投影为 number，Decimal 影子字段保留 string 精度来源。',
  };
}

function coreComponents() {
  const date = { type: 'string', format: 'date' };
  const dateTime = { type: 'string', format: 'date-time' };
  const id = { type: 'string', minLength: 1 };
  const stringArray = { type: 'array', items: { type: 'string' } };
  const pagination = {
    type: 'object',
    required: ['page', 'limit', 'total', 'totalPages'],
    properties: {
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      total: { type: 'integer', minimum: 0 },
      totalPages: { type: 'integer', minimum: 0 },
      sort: { type: 'string' },
      direction: { type: 'string', enum: ['asc', 'desc'] },
    },
  };
  const envelope = (data, extra = {}) => ({
    type: 'object',
    required: ['success', 'data'],
    properties: { success: { const: true }, data, ...extra },
    additionalProperties: true,
  });

  const rfq = coreResourceSchema({
    id,
    rfqNumber: { type: 'string' },
    customerId: id,
    customerName: { type: 'string' },
    partNumber: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
    uom: { type: 'string' },
    conditionCode: { type: 'string' },
    description: { type: 'string' },
    serialNumber: { type: 'string' },
    batchNumber: { type: 'string' },
    ataChapter: { type: 'string' },
    aircraftType: { type: 'string' },
    aircraftModel: { type: 'string' },
    alternatePartNumbers: stringArray,
    targetPrice: moneySchema(),
    targetPriceCurrency: { type: 'string' },
    certificateRequired: { type: 'boolean' },
    certificateType: { type: 'string' },
    requiredDate: date,
    responseDeadline: date,
    leadTimeDays: { type: 'integer', minimum: 0 },
    urgency: { type: 'string', enum: ['aog', 'urgent', 'standard'] },
    urgencyJustification: { type: 'string' },
    status: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    notes: { type: 'string' },
    createdAt: dateTime,
    createdBy: { type: 'string' },
  }, ['id', 'rfqNumber', 'customerId', 'customerName', 'partNumber', 'quantity', 'uom', 'conditionCode', 'targetPriceCurrency', 'certificateRequired', 'requiredDate', 'urgency', 'status', 'version', 'createdAt', 'createdBy']);

  const quotation = coreResourceSchema({
    id,
    quoteNumber: { type: 'string' },
    rfqId: id,
    customerId: id,
    customerName: { type: 'string' },
    customerEmail: { type: 'string', format: 'email' },
    customerContactName: { type: 'string' },
    partNumber: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
    unitPrice: moneySchema(),
    totalPrice: moneySchema(),
    costPrice: moneySchema(),
    margin: { type: 'number' },
    saleType: { type: 'string' },
    shipToId: id,
    shipForId: id,
    incoterm: { type: 'string' },
    incotermLocation: { type: 'string' },
    leadTimeDays: { type: 'integer', minimum: 0 },
    leadTimeBasis: { type: 'string' },
    moq: { type: 'integer', minimum: 0 },
    mpq: { type: 'integer', minimum: 0 },
    priceBasis: { type: 'string' },
    taxIncluded: { type: 'boolean' },
    taxRate: { type: 'number' },
    warrantyDays: { type: 'integer', minimum: 0 },
    warrantyTerms: { type: 'string' },
    validityDays: { type: 'integer', minimum: 1 },
    validityDeadline: dateTime,
    packagingRequirement: { type: 'string' },
    shippingMethod: { type: 'string' },
    countryOfOrigin: { type: 'string' },
    hsCode: { type: 'string' },
    eccn: { type: 'string' },
    dualUse: { type: 'boolean' },
    certificateFiles: stringArray,
    template: { type: 'string' },
    status: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    createdAt: dateTime,
    createdBy: { type: 'string' },
    expiryDate: date,
  }, ['id', 'quoteNumber', 'rfqId', 'customerId', 'customerName', 'partNumber', 'quantity', 'unitPrice', 'totalPrice', 'certificateFiles', 'template', 'status', 'version', 'validityDays', 'validityDeadline', 'warrantyDays', 'createdAt', 'createdBy', 'expiryDate']);

  const order = coreResourceSchema({
    id,
    orderNumber: { type: 'string' },
    soNumber: { type: 'string' },
    poNumber: { type: 'string' },
    quotationId: id,
    customerId: id,
    customerName: { type: 'string' },
    partNumber: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
    totalAmount: moneySchema(),
    status: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    createdAt: dateTime,
    deliveryDate: date,
    trackingNumber: { type: 'string' },
    carrier: { type: 'string' },
    saleType: { type: 'string' },
    incoterm: { type: 'string' },
    incotermLocation: { type: 'string' },
    shipToId: id,
    shipForId: id,
    warrantyDays: { type: 'integer', minimum: 0 },
    warrantyStartDate: date,
    certificateRequired: { type: 'boolean' },
    certificateType: { type: 'string' },
    certificateDelivered: { type: 'boolean' },
    packagingStandard: { type: 'string' },
    shippingMethod: { type: 'string' },
    carrierAccount: { type: 'string' },
    inspectionRequired: { type: 'boolean' },
    inspectionPassed: { type: 'boolean' },
    inspectionDate: date,
    customsClearanceRequired: { type: 'boolean' },
    customsDeclarationNo: { type: 'string' },
    importDuty: moneySchema(),
    vatAmount: moneySchema(),
    totalLandCost: moneySchema(),
    exchangeCoreCharge: moneySchema(),
    exchangeCoreDueDate: date,
    eSignatureCustomer: { type: 'string' },
    eSignatureSupplier: { type: 'string' },
  }, ['id', 'orderNumber', 'soNumber', 'quotationId', 'customerId', 'customerName', 'partNumber', 'quantity', 'totalAmount', 'status', 'version', 'createdAt']);

  const inventory = coreResourceSchema({
    id,
    partNumber: { type: 'string' },
    description: { type: 'string' },
    quantity: { type: 'integer', minimum: 0 },
    serialNumber: { type: 'string' },
    batchNumber: { type: 'string' },
    partCategory: { type: 'string' },
    trackingType: { type: 'string' },
    manufacturer: { type: 'string' },
    manufacturerCageCode: { type: 'string' },
    ataChapter: { type: 'string' },
    alternatePartNumbers: stringArray,
    conditionCode: { type: 'string' },
    certificateType: { type: 'string' },
    certificateNumber: { type: 'string' },
    certificateFileUrl: { type: 'string' },
    location: { type: 'string' },
    warehouse: { type: 'string' },
    shelf: { type: 'string' },
    storageCondition: { type: 'string' },
    unitCost: moneySchema(),
    unitOfMeasure: { type: 'string' },
    countryOfOrigin: { type: 'string' },
    hsCode: { type: 'string' },
    type: { type: 'string', enum: ['own', 'in_transit', 'virtual'] },
    supplierId: id,
    supplierName: { type: 'string' },
    eta: date,
    lifeLimited: { type: 'boolean' },
    remainingHours: { type: 'number' },
    remainingCycles: { type: 'number' },
    manufactureDate: date,
    shelfLifeDate: date,
    overhaulDate: date,
    nextOverhaulDue: date,
    adStatus: { type: 'string' },
    sbStatus: { type: 'string' },
    repairScheme: { type: 'string' },
    previousOperator: { type: 'string' },
    removalAircraftReg: { type: 'string' },
    removalDate: date,
    removalReason: { type: 'string' },
    nonIncidentStatement: { type: 'boolean' },
    militarySource: { type: 'boolean' },
    traceabilityDocs: stringArray,
    ata300Packaging: { type: 'boolean' },
    shelfLifeDays: { type: 'integer', minimum: 0 },
    storageTempMin: { type: 'number' },
    storageTempMax: { type: 'number' },
    hazardClass: { type: 'string' },
    notes: { type: 'string' },
  }, ['id', 'partNumber', 'description', 'quantity', 'partCategory', 'trackingType', 'conditionCode', 'certificateType', 'location', 'unitCost', 'unitOfMeasure', 'type']);

  const contact = coreResourceSchema({
    id,
    customerId: id,
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string' },
    role: { type: 'string' },
    isDefault: { type: 'boolean' },
    receiveRFQ: { type: 'boolean' },
    receivePO: { type: 'boolean' },
  }, ['id', 'customerId', 'name', 'email', 'role']);
  const customer = coreResourceSchema({
    id,
    name: { type: 'string' },
    buyerType: { type: 'string' },
    businessDescription: { type: 'string' },
    contactName: { type: 'string' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string' },
    registeredAddress: { type: 'string' },
    shipToAddress: { type: 'string' },
    shipForAddress: { type: 'string' },
    shippingContactName: { type: 'string' },
    shippingContactPhone: { type: 'string' },
    creditLimit: moneySchema(),
    creditRating: { type: 'string' },
    paymentTerms: { type: 'string' },
    paymentMethod: { type: 'string' },
    annualRevenue: moneySchema(),
    vatNumber: { type: 'string' },
    iataCode: { type: 'string' },
    icaoCode: { type: 'string' },
    aocNumber: { type: 'string' },
    preferredIncoterm: { type: 'string' },
    customsBroker: { type: 'string' },
    qualityApprovalStatus: { type: 'string' },
    status: { type: 'string', enum: ['active', 'inactive', 'at_risk'] },
    lastOrderDate: dateTime,
    contacts: { type: 'array', items: contact },
  }, ['id', 'name', 'contactName', 'email', 'status']);
  const supplier = coreResourceSchema({
    id,
    name: { type: 'string' },
    contactName: { type: 'string' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string' },
    address: { type: 'string' },
    level: { type: 'string', enum: ['S', 'A', 'B', 'C'] },
    status: { type: 'string' },
    paymentTerms: { type: 'string' },
    leadTime: { type: 'integer', minimum: 0 },
    performanceScore: { type: 'number' },
    lastOrderDate: dateTime,
    supplierType: { type: 'string', enum: ['OEM', 'MRO', 'Distributor', 'Broker', '145RepairStation'] },
    cageCode: { type: 'string' },
    caac145CertificateNo: { type: 'string' },
    caac145CertificateUrl: { type: 'string' },
    pmaHolder: { type: 'boolean' },
    ctsoaHolder: { type: 'boolean' },
    oemAuthorized: { type: 'boolean' },
    oemAuthorizationUrl: { type: 'string' },
    qualityApprovalExpiry: dateTime,
    lastAuditDate: dateTime,
    nextAuditDue: dateTime,
    approvedPartCategories: stringArray,
    specializesInAircraft: stringArray,
    incotermsOffered: stringArray,
    leadTimeAverage: { type: 'integer', minimum: 0 },
    onTimeDeliveryRate: { type: 'number', minimum: 0, maximum: 100 },
    certificateTypesProvided: stringArray,
    moqPolicy: { type: 'string' },
    warrantyPolicy: { type: 'string' },
    returnPolicy: { type: 'string' },
    bankAccountInfo: { type: 'string' },
  }, ['id', 'name', 'level', 'supplierType']);

  const requestBodies = {
    ProfileUpdate: { required: true, content: { 'application/json': { schema: schemaRef('ProfileUpdateRequest') } } },
    TokenPassword: { required: true, content: { 'application/json': { schema: schemaRef('TokenPasswordRequest') } } },
    ForgotPassword: { required: true, content: { 'application/json': { schema: schemaRef('ForgotPasswordRequest') } } },
    ChangePassword: { required: true, content: { 'application/json': { schema: schemaRef('ChangePasswordRequest') } } },
    DocumentTemplateCreate: { required: true, content: { 'application/json': { schema: schemaRef('DocumentTemplateCreateRequest') } } },
    DocumentTemplateUpdate: { required: true, content: { 'application/json': { schema: schemaRef('DocumentTemplateUpdateRequest') } } },
    CertificateTemplateCreate: { required: true, content: { 'application/json': { schema: schemaRef('CertificateTemplateCreateRequest') } } },
    CertificateTemplateUpdate: { required: true, content: { 'application/json': { schema: schemaRef('CertificateTemplateUpdateRequest') } } },
    CertificateIssue: { required: true, content: { 'application/json': { schema: schemaRef('CertificateIssueRequest') } } },
    CertificateRevoke: { content: { 'application/json': { schema: schemaRef('CertificateRevokeRequest') } } },
    CertificateRenew: { required: true, content: { 'application/json': { schema: schemaRef('CertificateRenewRequest') } } },
    WebhookEndpointCreate: { required: true, content: { 'application/json': { schema: schemaRef('WebhookEndpointCreateRequest') } } },
    WebhookEndpointUpdate: { content: { 'application/json': { schema: schemaRef('WebhookEndpointUpdateRequest') } } },
    WebhookSubscriptionReplace: { required: true, content: { 'application/json': { schema: schemaRef('WebhookSubscriptionReplaceRequest') } } },
    InboundEndpointCreate: { required: true, content: { 'application/json': { schema: schemaRef('InboundEndpointCreateRequest') } } },
    InboundEndpointUpdate: { content: { 'application/json': { schema: schemaRef('InboundEndpointUpdateRequest') } } },
    WebhookPhase2Request: { content: { 'application/json': { schema: schemaRef('WebhookPhase2Request') } } },
    OutboxReplay: { required: true, content: { 'application/json': { schema: schemaRef('OutboxReplayRequest') } } },
    OutboxCancel: { content: { 'application/json': { schema: schemaRef('OutboxCancelRequest') } } },
    NotificationDispatch: { required: true, content: { 'application/json': { schema: schemaRef('NotificationDispatchRequest') } } },
    QuotationTransition: { content: { 'application/json': { schema: schemaRef('QuotationTransitionRequest') } } },
    QuotationApprove: { required: true, content: { 'application/json': { schema: schemaRef('QuotationApproveRequest') } } },
    QuotationSend: { content: { 'application/json': { schema: schemaRef('QuotationSendRequest') } } },
    QuotationWithdraw: { required: true, content: { 'application/json': { schema: schemaRef('QuotationWithdrawRequest') } } },
    QuotationAccept: { content: { 'application/json': { schema: schemaRef('QuotationAcceptRequest') } } },
    RfqCreate: { required: true, content: { 'application/json': { schema: schemaRef('RfqCreateRequest') } } },
    RfqUpdate: { required: true, content: { 'application/json': { schema: schemaRef('RfqUpdateRequest') } } },
    RfqStatusUpdate: { required: true, content: { 'application/json': { schema: schemaRef('RfqStatusUpdateRequest') } } },
    QuotationCreate: { required: true, content: { 'application/json': { schema: schemaRef('QuotationCreateRequest') } } },
    QuotationUpdate: { required: true, content: { 'application/json': { schema: schemaRef('QuotationUpdateRequest') } } },
    OrderCreate: { required: true, content: { 'application/json': { schema: schemaRef('OrderCreateRequest') } } },
    OrderUpdate: { required: true, content: { 'application/json': { schema: schemaRef('OrderUpdateRequest') } } },
    OrderStatusUpdate: { required: true, content: { 'application/json': { schema: schemaRef('OrderStatusUpdateRequest') } } },
    InventoryCreate: { required: true, content: { 'application/json': { schema: schemaRef('InventoryCreateRequest') } } },
    InventoryUpdate: { required: true, content: { 'application/json': { schema: schemaRef('InventoryUpdateRequest') } } },
    CustomerCreate: { required: true, content: { 'application/json': { schema: schemaRef('CustomerCreateRequest') } } },
    CustomerUpdate: { required: true, content: { 'application/json': { schema: schemaRef('CustomerUpdateRequest') } } },
    SupplierCreate: { required: true, content: { 'application/json': { schema: schemaRef('SupplierCreateRequest') } } },
    SupplierUpdate: { required: true, content: { 'application/json': { schema: schemaRef('SupplierUpdateRequest') } } },
    InventoryItemCreate: { required: true, content: { 'application/json': { schema: schemaRef('InventoryItemCreateRequest') } } },
    InventoryItemUpdate: { content: { 'application/json': { schema: schemaRef('InventoryItemUpdateRequest') } } },
    InventoryReserve: { required: true, content: { 'application/json': { schema: schemaRef('InventoryReserveRequest') } } },
    InventoryRelease: { required: true, content: { 'application/json': { schema: schemaRef('InventoryReleaseRequest') } } },
    InventoryOutbound: { required: true, content: { 'application/json': { schema: schemaRef('InventoryOutboundRequest') } } },
    InquiryCreate: { required: true, content: { 'application/json': { schema: schemaRef('InquiryCreateRequest') } } },
    NotificationPreferenceUpdate: { required: true, content: { 'application/json': { schema: schemaRef('NotificationPreferenceUpdateRequest') } } },
    ChannelBindingCreate: { required: true, content: { 'application/json': { schema: schemaRef('ChannelBindingCreateRequest') } } },
    ChannelBindingUpdate: { content: { 'application/json': { schema: schemaRef('ChannelBindingUpdateRequest') } } },
    PushSubscribe: { required: true, content: { 'application/json': { schema: schemaRef('PushSubscribeRequest') } } },
    EmailClassify: { required: true, content: { 'application/json': { schema: schemaRef('EmailClassifyRequest') } } },
    EmailAccountCreate: { required: true, content: { 'application/json': { schema: schemaRef('EmailAccountCreateRequest') } } },
    EmailAccountUpdate: { content: { 'application/json': { schema: schemaRef('EmailAccountUpdateRequest') } } },
    ManagedUserCreate: { required: true, content: { 'application/json': { schema: schemaRef('ManagedUserCreateRequest') } } },
    ManagedUserUpdate: { content: { 'application/json': { schema: schemaRef('ManagedUserUpdateRequest') } } },
    SupplierFollowUpLogBatchCreate: { required: true, content: { 'application/json': { schema: schemaRef('SupplierFollowUpLogBatchCreateRequest') } } },
    SupplierQuoteCreate: { required: true, content: { 'application/json': { schema: schemaRef('SupplierQuoteCreateRequest') } } },
    SupplierQuoteUpdate: { content: { 'application/json': { schema: schemaRef('SupplierQuoteUpdateRequest') } } },
    SupplierQuoteCompare: { required: true, content: { 'application/json': { schema: schemaRef('SupplierQuoteCompareRequest') } } },
    AuditLogCreate: { required: true, content: { 'application/json': { schema: schemaRef('AuditLogCreateRequest') } } },
    ApiKeyCreate: { required: true, content: { 'application/json': { schema: schemaRef('ApiKeyCreateRequest') } } },
    ApiKeyUpdate: { content: { 'application/json': { schema: schemaRef('ApiKeyUpdateRequest') } } },
    PriceRecommendationBatch: { required: true, content: { 'application/json': { schema: schemaRef('PriceRecommendationBatchRequest') } } },
    ConsignmentCreate: { required: true, content: { 'application/json': { schema: schemaRef('ConsignmentCreateRequest') } } },
    ConsignmentUpdate: { content: { 'application/json': { schema: schemaRef('ConsignmentUpdateRequest') } } },
    ConsignmentConsume: { required: true, content: { 'application/json': { schema: schemaRef('ConsignmentConsumeRequest') } } },
    FmvBatch: { required: true, content: { 'application/json': { schema: schemaRef('FmvBatchRequest') } } },
    WorkflowDefinitionCreate: { required: true, content: { 'application/json': { schema: schemaRef('WorkflowDefinitionCreateRequest') } } },
    WorkflowDefinitionUpdate: { content: { 'application/json': { schema: schemaRef('WorkflowDefinitionUpdateRequest') } } },
    WorkflowInstanceCreate: { required: true, content: { 'application/json': { schema: schemaRef('WorkflowInstanceCreateRequest') } } },
    WorkflowDecision: { content: { 'application/json': { schema: schemaRef('WorkflowDecisionRequest') } } },
    WorkflowTransfer: { required: true, content: { 'application/json': { schema: schemaRef('WorkflowTransferRequest') } } },
    WorkflowCancel: { content: { 'application/json': { schema: schemaRef('WorkflowCancelRequest') } } },
    AgentRuntimeTaskSync: { required: true, content: { 'application/json': { schema: schemaRef('AgentRuntimeTaskSyncRequest') } } },
    AgentCreate: { required: true, content: { 'application/json': { schema: schemaRef('AgentCreateRequest') } } },
    AgentUpdate: { content: { 'application/json': { schema: schemaRef('AgentUpdateRequest') } } },
    AgentRun: { content: { 'application/json': { schema: schemaRef('AgentRunRequest') } } },
    AiModelCreate: { required: true, content: { 'application/json': { schema: schemaRef('AiModelCreateRequest') } } },
    AiModelUpdate: { content: { 'application/json': { schema: schemaRef('AiModelUpdateRequest') } } },
    AiParseEmail: { required: true, content: { 'application/json': { schema: schemaRef('AiParseEmailRequest') } } },
    AiAnalyzeQuotes: { required: true, content: { 'application/json': { schema: schemaRef('AiAnalyzeQuotesRequest') } } },
    AiGenerateEmail: { required: true, content: { 'application/json': { schema: schemaRef('AiGenerateEmailRequest') } } },
    AiChat: { required: true, content: { 'application/json': { schema: schemaRef('AiChatRequest') } } },
    AuctionCreate: { required: true, content: { 'application/json': { schema: schemaRef('AuctionCreateRequest') } } },
    AuctionUpdate: { content: { 'application/json': { schema: schemaRef('AuctionUpdateRequest') } } },
    AuctionBidCreate: { required: true, content: { 'application/json': { schema: schemaRef('AuctionBidCreateRequest') } } },
  };

  const rfqBase = {
    customerId: id,
    partNumber: { type: 'string', minLength: 1 },
    quantity: { type: 'integer', minimum: 1 },
    uom: { type: 'string', default: 'EA' },
    conditionCode: { type: 'string', default: 'NE' },
    description: { type: 'string' },
    serialNumber: { type: 'string' },
    batchNumber: { type: 'string' },
    ataChapter: { type: 'string' },
    aircraftType: { type: 'string' },
    aircraftModel: { type: 'string' },
    alternatePartNumbers: { oneOf: [stringArray, { type: 'string' }] },
    targetPrice: moneySchema(),
    targetPriceCurrency: { type: 'string', default: 'USD' },
    certificateRequired: { type: 'boolean', default: true },
    certificateType: { type: 'string' },
    requiredDate: date,
    responseDeadline: date,
    leadTimeDays: { type: 'integer', minimum: 0 },
    urgency: { type: 'string', enum: ['AOG', 'URGENT', 'STANDARD'], default: 'STANDARD' },
    urgencyJustification: { type: 'string' },
    notes: { type: 'string' },
    emailId: id,
  };
  const quotationBase = {
    rfqId: id, customerId: id, partNumber: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1 },
    unitPrice: { type: 'number', minimum: 0 }, costPrice: { type: 'number', minimum: 0 }, certificateFiles: stringArray,
    template: { type: 'string' }, validityDays: { type: 'integer', minimum: 1 }, saleType: { type: 'string', default: 'Sale' },
    shipToId: id, shipForId: id, incoterm: { type: 'string' }, incotermLocation: { type: 'string' }, leadTimeDays: { type: 'integer', minimum: 0 },
    leadTimeBasis: { type: 'string' }, moq: { type: 'integer', minimum: 0 }, mpq: { type: 'integer', minimum: 0 }, priceBasis: { type: 'string' },
    taxIncluded: { type: 'boolean', default: true }, taxRate: { type: 'number' }, warrantyDays: { type: 'integer', minimum: 0, default: 90 },
    warrantyTerms: { type: 'string' }, packagingRequirement: { type: 'string' }, shippingMethod: { type: 'string' }, ccRecipients: { oneOf: [stringArray, { type: 'string' }] },
    commonNote: { type: 'string' }, eSignature: { type: 'string' }, eSignatureStatus: { type: 'string', default: 'Unsigned' }, countryOfOrigin: { type: 'string' }, hsCode: { type: 'string' }, eccn: { type: 'string' }, dualUse: { type: 'boolean', default: false },
  };
  const orderBase = {
    quotationId: id, customerId: id, quotationVersion: { type: 'integer', minimum: 1 }, poNumber: { type: 'string' }, deliveryDate: date,
    templateId: id, saleType: { type: 'string', default: 'Sale' }, incoterm: { type: 'string' }, incotermLocation: { type: 'string' }, shipToId: id, shipForId: id,
    warrantyDays: { type: 'integer', minimum: 0 }, warrantyStartDate: date, certificateRequired: { type: 'boolean', default: true }, certificateType: { type: 'string' }, certificateDelivered: { type: 'boolean', default: false }, packagingStandard: { type: 'string' }, shippingMethod: { type: 'string' }, carrierAccount: { type: 'string' }, inspectionRequired: { type: 'boolean', default: false }, inspectionPassed: { type: 'boolean' }, inspectionDate: date, customsClearanceRequired: { type: 'boolean', default: false }, customsDeclarationNo: { type: 'string' }, importDuty: { type: 'number' }, vatAmount: { type: 'number' }, totalLandCost: { type: 'number' }, exchangeCoreCharge: { type: 'number' }, exchangeCoreDueDate: date, eSignatureCustomer: { type: 'string' }, eSignatureSupplier: { type: 'string' },
  };
  const inventoryBase = {
    partNumber: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, partCategory: { type: 'string', default: 'CONSUMABLE' }, trackingType: { type: 'string', default: 'BATCH' }, quantity: { type: 'integer', minimum: 0, default: 0 }, location: { type: 'string', minLength: 1 }, warehouse: { type: 'string' }, shelf: { type: 'string' }, conditionCode: { type: 'string', default: 'NE' }, certificateType: { type: 'string', default: 'NONE' }, certificateNumber: { type: 'string' }, certificateFileUrl: { type: 'string' }, serialNumber: { type: 'string' }, batchNumber: { type: 'string' }, manufacturer: { type: 'string' }, manufacturerCageCode: { type: 'string' }, ataChapter: { type: 'string' }, alternatePartNumbers: { type: 'string' }, unitOfMeasure: { type: 'string', default: 'EA' }, countryOfOrigin: { type: 'string' }, hsCode: { type: 'string' }, unitCost: { type: 'number', minimum: 0, default: 0 }, type: { type: 'string', default: 'OWN' }, supplierId: id, eta: date, lifeLimited: { type: 'boolean', default: false }, totalHours: { type: 'number' }, totalCycles: { type: 'number' }, remainingHours: { type: 'number' }, remainingCycles: { type: 'number' }, manufactureDate: date, shelfLifeDate: date, overhaulDate: date, nextOverhaulDue: date, adStatus: { type: 'string' }, sbStatus: { type: 'string' }, repairScheme: { type: 'string' }, previousOperator: { type: 'string' }, removalAircraftReg: { type: 'string' }, removalDate: date, removalReason: { type: 'string' }, nonIncidentStatement: { type: 'boolean', default: false }, militarySource: { type: 'boolean', default: false }, traceabilityDocs: { type: 'string' }, storageCondition: { type: 'string' }, ata300Packaging: { type: 'boolean', default: false }, shelfLifeDays: { type: 'integer', minimum: 0 }, storageTempMin: { type: 'number' }, storageTempMax: { type: 'number' }, hazardClass: { type: 'string' }, notes: { type: 'string', maxLength: 2000 },
  };
  const customerBase = { name: { type: 'string', minLength: 1 }, contactName: { type: 'string', minLength: 1 }, email: { type: 'string', format: 'email' }, phone: { type: 'string' }, buyerType: { type: 'string' }, businessDescription: { type: 'string' }, registeredAddress: { type: 'string' }, shipToAddress: { type: 'string' }, shipForAddress: { type: 'string' }, shippingContactName: { type: 'string' }, shippingContactPhone: { type: 'string' }, creditLimit: { type: 'number' }, creditRating: { type: 'string' }, paymentTerms: { type: 'string' }, paymentMethod: { type: 'string' }, annualRevenue: { type: 'number' }, vatNumber: { type: 'string' }, iataCode: { type: 'string' }, icaoCode: { type: 'string' }, aocNumber: { type: 'string' }, preferredIncoterm: { type: 'string' }, customsBroker: { type: 'string' }, qualityApprovalStatus: { type: 'string' }, contacts: { type: 'array', items: contact }, competitorListings: { type: 'array', items: { type: 'object', required: ['competitorName'], properties: { competitorName: { type: 'string', minLength: 1 }, advantageParts: { type: 'string' }, priceLevel: { type: 'string' }, notes: { type: 'string' } }, additionalProperties: false } } };
  const supplierBase = { name: { type: 'string', minLength: 1 }, contactName: { type: 'string', minLength: 1 }, email: { type: 'string', format: 'email' }, phone: { type: 'string' }, address: { type: 'string' }, level: { type: 'string', enum: ['S', 'A', 'B', 'C'] }, paymentTerms: { type: 'string' }, leadTime: { type: 'integer', minimum: 0 }, supplierType: { type: 'string', enum: ['OEM', 'MRO', 'Distributor', 'Broker', '145RepairStation'] }, cageCode: { type: 'string' }, caac145CertificateNo: { type: 'string' }, caac145CertificateUrl: { type: 'string' }, pmaHolder: { type: 'boolean' }, ctsoaHolder: { type: 'boolean' }, oemAuthorized: { type: 'boolean' }, oemAuthorizationUrl: { type: 'string' }, qualityApprovalExpiry: date, lastAuditDate: date, nextAuditDue: date, approvedPartCategories: { oneOf: [stringArray, { type: 'string' }] }, specializesInAircraft: { oneOf: [stringArray, { type: 'string' }] }, incotermsOffered: { oneOf: [stringArray, { type: 'string' }] }, leadTimeAverage: { type: 'integer', minimum: 0 }, onTimeDeliveryRate: { type: 'number', minimum: 0, maximum: 100 }, certificateTypesProvided: { oneOf: [stringArray, { type: 'string' }] }, moqPolicy: { type: 'string' }, warrantyPolicy: { type: 'string' }, returnPolicy: { type: 'string' }, bankAccountInfo: { type: 'string' } };

  const authUser = coreResourceSchema({
    id,
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    role: { type: 'string' },
    department: { type: ['string', 'null'] },
    avatar: { type: ['string', 'null'] },
    lastLoginAt: dateTime,
  }, ['id', 'email', 'name', 'role']);
  const managedUser = coreResourceSchema({
    id,
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string' },
    department: { type: 'string' },
    avatar: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    activationPending: { type: 'boolean' },
    activationExpiresAt: { type: ['string', 'null'], format: 'date-time' },
    lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
  }, ['id', 'name', 'email', 'role', 'department', 'isActive', 'activationPending']);
  const email = coreResourceSchema({
    id,
    from: { type: 'string', format: 'email' },
    fromName: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    receivedAt: dateTime,
    type: { type: 'string', enum: ['aog', 'standard', 'inquiry', 'spam'] },
    isRead: { type: 'boolean' },
    attachments: { type: 'array', items: { type: 'string' } },
    accountId: { type: ['string', 'null'] },
    rfq: { type: ['object', 'null'], additionalProperties: true },
  }, ['id', 'from', 'fromName', 'subject', 'body', 'receivedAt', 'type', 'isRead', 'attachments']);
  const emailAccount = coreResourceSchema({
    id,
    email: { type: 'string', format: 'email' },
    displayName: { type: ['string', 'null'] },
    imapServer: { type: 'string' },
    imapPort: { type: 'string' },
    smtpServer: { type: 'string' },
    smtpPort: { type: 'string' },
    isActive: { type: 'boolean' },
    isDefault: { type: 'boolean' },
    accountType: { type: 'string' },
    lastSyncAt: { type: ['string', 'null'], format: 'date-time' },
    syncInterval: { type: 'integer', minimum: 0 },
  }, ['id', 'email', 'imapServer', 'imapPort', 'smtpServer', 'smtpPort', 'isActive', 'isDefault', 'accountType', 'syncInterval']);
  const authEmailDeliveryItem = coreResourceSchema({
    id,
    purpose: { type: 'string', enum: ['USER_ACTIVATION', 'PASSWORD_RESET'] },
    deliveryStatus: { type: 'string', enum: ['sent', 'pending', 'skipped', 'failed'] },
    toEmail: { type: 'string', format: 'email' },
    subject: { type: 'string' },
    accountEmail: { type: ['string', 'null'], format: 'email' },
    errorMessage: { type: ['string', 'null'] },
    createdAt: dateTime,
    sentAt: { type: ['string', 'null'], format: 'date-time' },
  }, ['id', 'purpose', 'deliveryStatus', 'toEmail', 'subject', 'accountEmail', 'createdAt', 'sentAt']);
  const authEmailDelivery = coreResourceSchema({
    items: { type: 'array', items: authEmailDeliveryItem },
    summary: {
      type: 'object',
      required: ['total', 'sent', 'failed', 'skipped', 'pending'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        sent: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
        skipped: { type: 'integer', minimum: 0 },
        pending: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  }, ['items', 'summary']);
  const session = coreResourceSchema({
    id,
    deviceName: { type: 'string' },
    ipAddress: { type: ['string', 'null'] },
    userAgent: { type: ['string', 'null'] },
    createdAt: dateTime,
    lastSeenAt: dateTime,
    expiresAt: dateTime,
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedReason: { type: ['string', 'null'] },
    isCurrent: { type: 'boolean' },
    isActive: { type: 'boolean' },
  }, ['id', 'deviceName', 'createdAt', 'lastSeenAt', 'expiresAt', 'isCurrent', 'isActive']);
  const securityEvent = coreResourceSchema({
    id,
    sessionId: { type: ['string', 'null'] },
    type: { type: 'string' },
    severity: { type: 'string' },
    message: { type: 'string' },
    ipAddress: { type: ['string', 'null'] },
    userAgent: { type: ['string', 'null'] },
    metadata: {},
    status: { type: 'string' },
    createdAt: dateTime,
    resolvedAt: { type: ['string', 'null'], format: 'date-time' },
  }, ['id', 'type', 'severity', 'message', 'status', 'createdAt']);

  const managedUserOnboarding = coreResourceSchema({
    user: managedUser,
    activationToken: { type: 'string', description: 'Internal administrator handoff token; never included in public samples.' },
    activationLink: { type: 'string', format: 'uri' },
    activationExpiresAt: dateTime,
    emailDeliveryStatus: { type: 'string', enum: ['sent', 'pending', 'skipped', 'failed'] },
    emailDeliveryError: { type: ['string', 'null'] },
    outboundEmailId: { type: ['string', 'null'] },
  }, ['user', 'activationToken', 'activationLink', 'activationExpiresAt', 'emailDeliveryStatus']);
  const managedUserDelete = coreResourceSchema({ message: { type: 'string' } }, ['message']);

  const listEnvelope = (item, extra = {}) => envelope(
    { type: 'array', items: schemaRef(item) },
    { pagination: schemaRef('Pagination'), ...extra },
  );
  const supplierFollowUpLog = coreResourceSchema({
    id,
    supplierId: id,
    supplierName: { type: 'string' },
    taskId: id,
    rfqId: { type: ['string', 'null'] },
    rfqNumber: { type: ['string', 'null'] },
    actionType: { type: 'string', enum: ['recorded_contact_follow_up', 'wechat_follow_up', 'whatsapp_follow_up', 'phone_follow_up', 'contact_missing'] },
    outcome: { type: 'string', enum: ['contacted_waiting_quote', 'quote_promised', 'follow_up_sent', 'contact_invalid'] },
    notes: { type: ['string', 'null'] },
    preferredChannel: { type: ['string', 'null'], enum: ['email', 'phone', 'manual', null] },
    createdAt: dateTime,
    createdBy: { type: 'string' },
  }, ['id', 'supplierId', 'supplierName', 'taskId', 'actionType', 'outcome', 'createdAt', 'createdBy']);
  const supplierQuoteSupplier = coreResourceSchema({
    id,
    name: { type: 'string' },
    level: { type: 'string', enum: ['S', 'A', 'B', 'C'] },
    performanceScore: { type: ['number', 'null'] },
    contactName: { type: ['string', 'null'] },
    contactEmail: { type: ['string', 'null'], format: 'email' },
  }, ['id', 'name', 'level']);
  const supplierQuote = coreResourceSchema({
    id,
    rfqId: { type: ['string', 'null'] },
    inquiryId: { type: ['string', 'null'] },
    partNumber: { type: 'string' },
    description: { type: ['string', 'null'] },
    quantity: { type: 'integer', minimum: 1 },
    unitPrice: moneySchema(),
    totalPrice: moneySchema(),
    leadTimeDays: { type: 'integer', minimum: 0 },
    validUntil: { type: ['string', 'null'], format: 'date-time' },
    notes: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'expired'] },
    isWinner: { type: 'boolean' },
    ruleScore: { type: ['number', 'null'] },
    createdAt: dateTime,
    supplier: supplierQuoteSupplier,
  }, ['id', 'partNumber', 'quantity', 'unitPrice', 'totalPrice', 'leadTimeDays', 'status', 'isWinner', 'createdAt', 'supplier']);
  const supplierQuoteComparisonItem = coreResourceSchema({
    id,
    partNumber: { type: 'string' },
    supplier: supplierQuoteSupplier,
    unitPrice: moneySchema(),
    totalPrice: moneySchema(),
    leadTimeDays: { type: 'integer', minimum: 0 },
    priceDiff: { type: ['number', 'null'] },
    isLowestPrice: { type: 'boolean' },
    scoreComponents: {
      type: 'object',
      required: ['price', 'leadTime', 'supplierPerformance'],
      properties: {
        price: { type: ['integer', 'null'] },
        leadTime: { type: ['integer', 'null'] },
        supplierPerformance: { type: ['integer', 'null'] },
      },
      additionalProperties: false,
    },
    ruleScore: { type: ['number', 'null'] },
    status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'expired'] },
    isWinner: { type: 'boolean' },
  }, ['id', 'partNumber', 'supplier', 'unitPrice', 'totalPrice', 'leadTimeDays', 'isLowestPrice', 'scoreComponents', 'status', 'isWinner']);
  const supplierQuoteComparison = coreResourceSchema({
    quotes: { type: 'array', items: supplierQuoteComparisonItem },
    topRanked: { oneOf: [supplierQuoteComparisonItem, { type: 'null' }] },
    summary: {
      type: 'object',
      required: ['totalQuotes', 'lowestPrice', 'highestPrice', 'averagePrice'],
      properties: {
        totalQuotes: { type: 'integer', minimum: 0 },
        lowestPrice: { type: ['number', 'null'] },
        highestPrice: { type: ['number', 'null'] },
        averagePrice: { type: ['number', 'null'] },
      },
      additionalProperties: false,
    },
    metadata: {
      type: 'object',
      required: ['status', 'source', 'algorithmVersion', 'sampleSize', 'asOf', 'reason', 'decisionBoundary'],
      properties: {
        status: { type: 'string', enum: ['available', 'insufficient_data', 'unavailable'] },
        source: { type: 'string' },
        algorithmVersion: { type: 'string' },
        sampleSize: { type: 'integer', minimum: 0 },
        asOf: dateTime,
        reason: { type: 'string' },
        decisionBoundary: { type: 'string' },
      },
      additionalProperties: false,
    },
  }, ['quotes', 'topRanked', 'summary', 'metadata']);
  const auditLog = coreResourceSchema({
    id,
    userId: { type: ['string', 'null'] },
    userName: { type: ['string', 'null'] },
    userRole: { type: ['string', 'null'] },
    action: { type: 'string' },
    resourceType: { type: 'string' },
    resourceId: { type: ['string', 'null'] },
    resourceName: { type: ['string', 'null'] },
    changes: { type: ['string', 'null'] },
    details: { type: ['string', 'null'] },
    ipAddress: { type: ['string', 'null'] },
    userAgent: { type: ['string', 'null'] },
    sessionId: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['SUCCESS', 'FAILURE'] },
    errorMessage: { type: ['string', 'null'] },
    createdAt: dateTime,
  }, ['id', 'action', 'resourceType', 'status', 'createdAt']);
  const auditLogStats = coreResourceSchema({
    actionsByType: { type: 'array', items: { type: 'object', required: ['action', 'count'], properties: { action: { type: 'string' }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
    resourcesByType: { type: 'array', items: { type: 'object', required: ['resourceType', 'count'], properties: { resourceType: { type: 'string' }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
    dailyTrend: { type: 'array', items: { type: 'object', required: ['date', 'count'], properties: { date: { type: 'string', format: 'date' }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
    totalToday: { type: 'integer', minimum: 0 },
    failedToday: { type: 'integer', minimum: 0 },
    topUsers: { type: 'array', items: { type: 'object', required: ['userId', 'userName', 'count'], properties: { userId: { type: ['string', 'null'] }, userName: { type: ['string', 'null'] }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
    topResourceTypes: { type: 'array', items: { type: 'object', required: ['resourceType', 'count'], properties: { resourceType: { type: 'string' }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  }, ['actionsByType', 'resourcesByType', 'dailyTrend', 'totalToday', 'failedToday', 'topUsers', 'topResourceTypes']);
  const featureStatus = coreResourceSchema({
    key: { type: 'string', enum: ['pricingBi', 'agentDemo'] },
    enabled: { type: 'boolean' },
    defaultEnabled: { type: 'boolean' },
    environmentVariable: { type: 'string' },
    description: { type: 'string' },
  }, ['key', 'enabled', 'defaultEnabled', 'environmentVariable', 'description']);
  const ipc = coreResourceSchema({
    id,
    partNumber: { type: 'string' },
    description: { type: 'string' },
    ataChapter: { type: 'string' },
    aircraftTypes: stringArray,
    supersededBy: { type: ['string', 'null'] },
    interchangeableWith: stringArray,
    alternateParts: stringArray,
  }, ['id', 'partNumber', 'description', 'ataChapter', 'aircraftTypes', 'interchangeableWith', 'alternateParts']);
  const ipcCompatibility = coreResourceSchema({
    isCompatible: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
    sbRequirements: { type: 'array', items: { type: 'string' } },
  }, ['isCompatible', 'warnings', 'sbRequirements']);
  const apiKey = coreResourceSchema({
    id,
    name: { type: 'string' },
    keyPrefix: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string', minLength: 1 } },
    rateLimit: { type: 'integer', minimum: 1 },
    isActive: { type: 'boolean' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    createdBy: id,
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'name', 'keyPrefix', 'scopes', 'rateLimit', 'isActive', 'createdBy', 'createdAt', 'updatedAt']);
  const apiKeyCreate = coreResourceSchema({
    id,
    name: { type: 'string' },
    key: { type: 'string', writeOnly: true, description: 'Returned once on creation; never persisted or returned by list/update operations.' },
    keyPrefix: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string', minLength: 1 } },
    rateLimit: { type: 'integer', minimum: 1 },
    isActive: { type: 'boolean' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: dateTime,
  }, ['id', 'name', 'key', 'keyPrefix', 'scopes', 'rateLimit', 'isActive', 'createdAt']);
  const apiKeyDelete = coreResourceSchema({ message: { type: 'string' } }, ['message']);
  const priceAvailability = coreResourceSchema({
    status: { type: 'string', enum: ['available', 'insufficient_data', 'unavailable', 'disabled'] },
    source: { type: 'string' },
    algorithmVersion: { type: ['string', 'null'] },
    sampleSize: { type: 'integer', minimum: 0 },
    asOf: dateTime,
    reason: { type: ['string', 'null'] },
    decisionBoundary: { type: 'string' },
  }, ['status', 'source', 'algorithmVersion', 'sampleSize', 'asOf', 'decisionBoundary']);
  const historicalPriceStats = coreResourceSchema({
    avgPrice: { type: 'number', minimum: 0 },
    minPrice: { type: 'number', minimum: 0 },
    maxPrice: { type: 'number', minimum: 0 },
    medianPrice: { type: 'number', minimum: 0 },
    transactionCount: { type: 'integer', minimum: 0 },
    lastTransactionDate: { type: ['string', 'null'], format: 'date-time' },
    priceTrend: { type: 'string', enum: ['up', 'down', 'stable'] },
    trendPercent: { type: 'number' },
  }, ['avgPrice', 'minPrice', 'maxPrice', 'medianPrice', 'transactionCount', 'lastTransactionDate', 'priceTrend', 'trendPercent']);
  const priceRecommendation = coreResourceSchema({
    partNumber: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
    customerId: { type: ['string', 'null'] },
    historicalStats: historicalPriceStats,
    recommendedPrice: { type: 'number', minimum: 0 },
    priceRange: { type: 'object', required: ['low', 'high'], properties: { low: { type: 'number', minimum: 0 }, high: { type: 'number', minimum: 0 } }, additionalProperties: false },
    discountAnalysis: { type: 'object', required: ['customerTierDiscount', 'volumeDiscount', 'paymentTermDiscount', 'totalDiscount'], properties: { customerTierDiscount: { type: 'number' }, volumeDiscount: { type: 'number' }, paymentTermDiscount: { type: 'number' }, totalDiscount: { type: 'number' } }, additionalProperties: false },
    winProbability: { type: 'number', minimum: 0, maximum: 100 },
    winProbabilityFactors: { type: 'object', required: ['priceFactor', 'customerFactor', 'marketFactor'], properties: { priceFactor: { type: 'number' }, customerFactor: { type: 'number' }, marketFactor: { type: 'number' } }, additionalProperties: false },
    marketReference: { type: ['object', 'null'], additionalProperties: true },
    generatedAt: dateTime,
  }, ['partNumber', 'quantity', 'historicalStats', 'recommendedPrice', 'priceRange', 'discountAnalysis', 'winProbability', 'winProbabilityFactors', 'generatedAt']);
  const priceHistory = coreResourceSchema({
    partNumber: { type: 'string' },
    dataPoints: { type: 'array', items: { type: 'object', required: ['date', 'price', 'quantity', 'type'], properties: { date: { type: 'string', format: 'date' }, price: { type: 'number' }, quantity: { type: 'integer', minimum: 1 }, type: { type: 'string', enum: ['quotation', 'order'] } }, additionalProperties: false } },
    summary: { type: 'object', required: ['totalTransactions', 'firstTransactionDate', 'lastTransactionDate'], properties: { totalTransactions: { type: 'integer', minimum: 0 }, firstTransactionDate: { type: ['string', 'null'], format: 'date' }, lastTransactionDate: { type: ['string', 'null'], format: 'date' } }, additionalProperties: false },
  }, ['partNumber', 'dataPoints', 'summary']);
  const priceDashboard = coreResourceSchema({
    quotationStats: { type: 'object', required: ['avgMargin', 'totalQuotations'], properties: { avgMargin: { type: 'number' }, totalQuotations: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    orderStats: { type: 'object', required: ['avgMargin', 'totalOrders'], properties: { avgMargin: { type: 'number' }, totalOrders: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    generatedAt: dateTime,
  }, ['quotationStats', 'orderStats', 'generatedAt']);
  const priceRecommendationBatchRequest = coreRequestSchema({
    items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['partNumber', 'quantity'], properties: { partNumber: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1 }, customerId: id }, additionalProperties: false } },
  }, ['items']);
  const pricingBiSummary = coreResourceSchema({
    feature: featureStatus,
    avgMargin: { type: ['number', 'null'] },
    marginTrend: { type: ['number', 'null'] },
    priceCompetitiveness: { type: ['number', 'null'] },
    competitivenessTrend: { type: ['number', 'null'] },
    pendingSuggestions: { type: ['integer', 'null'] },
    potentialUpside: { type: ['number', 'null'] },
    totalQuotes: { type: ['integer', 'null'] },
    wonDeals: { type: ['integer', 'null'] },
    lostDeals: { type: ['integer', 'null'] },
    winRate: { type: ['number', 'null'] },
    metadata: priceAvailability,
  }, ['feature', 'avgMargin', 'marginTrend', 'priceCompetitiveness', 'competitivenessTrend', 'pendingSuggestions', 'potentialUpside', 'totalQuotes', 'wonDeals', 'lostDeals', 'winRate', 'metadata']);
  const pricingBiCollection = coreResourceSchema({
    feature: featureStatus,
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    unclassifiedCount: { type: 'integer', minimum: 0 },
    metadata: priceAvailability,
  }, ['feature', 'items', 'metadata']);
  const consumptionTrend = coreResourceSchema({
    period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
    totalQuantity: { type: 'integer', minimum: 0 },
    totalValue: moneySchema(),
    transactionCount: { type: 'integer', minimum: 0 },
    topPartNumbers: { type: 'array', items: { type: 'object', required: ['partNumber', 'quantity', 'value'], properties: { partNumber: { type: 'string' }, quantity: { type: 'integer', minimum: 0 }, value: moneySchema() }, additionalProperties: false } },
  }, ['period', 'totalQuantity', 'totalValue', 'transactionCount', 'topPartNumbers']);
  const safetyStock = coreResourceSchema({
    partNumber: { type: 'string' },
    currentStock: { type: 'integer', minimum: 0 },
    avgMonthlyConsumption: { type: 'number', minimum: 0 },
    maxMonthlyConsumption: { type: 'number', minimum: 0 },
    leadTimeDays: { type: 'integer', minimum: 1 },
    safetyStockLevel: { type: 'integer', minimum: 0 },
    reorderPoint: { type: 'integer', minimum: 0 },
    reorderQuantity: { type: 'integer', minimum: 0 },
    stockStatus: { type: 'string', enum: ['adequate', 'low', 'critical', 'excess'] },
    daysOfSupply: { type: 'integer', minimum: 0 },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
  }, ['partNumber', 'currentStock', 'avgMonthlyConsumption', 'maxMonthlyConsumption', 'leadTimeDays', 'safetyStockLevel', 'reorderPoint', 'reorderQuantity', 'stockStatus', 'daysOfSupply', 'confidence']);
  const inventoryHealthSummary = coreResourceSchema({
    totalItems: { type: 'integer', minimum: 0 },
    criticalItems: { type: 'integer', minimum: 0 },
    lowItems: { type: 'integer', minimum: 0 },
    excessItems: { type: 'integer', minimum: 0 },
    adequateItems: { type: 'integer', minimum: 0 },
    totalInventoryValue: moneySchema(),
    recommendations: { type: 'array', items: safetyStock },
  }, ['totalItems', 'criticalItems', 'lowItems', 'excessItems', 'adequateItems', 'totalInventoryValue', 'recommendations']);
  const seasonalForecast = coreResourceSchema({
    partNumber: { type: 'string' },
    seasonalFactors: { type: 'array', items: { type: 'object', required: ['month', 'factor', 'trend'], properties: { month: { type: 'integer', minimum: 1, maximum: 12 }, factor: { type: 'number', minimum: 0 }, trend: { type: 'string', enum: ['high', 'normal', 'low'] } }, additionalProperties: false } },
    nextQuarterForecast: { type: 'number', minimum: 0 },
  }, ['partNumber', 'seasonalFactors', 'nextQuarterForecast']);
  const consignment = coreResourceSchema({
    id,
    agreementNumber: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['ACTIVE', 'EXPIRED', 'TERMINATED', 'SETTLING'] },
    supplierId: id,
    customerId: { type: ['string', 'null'] },
    supplierName: { type: 'string' },
    customerName: { type: ['string', 'null'] },
    partNumber: { type: 'string' },
    partDescription: { type: ['string', 'null'] },
    quantity: { type: 'integer', minimum: 0 },
    unitCost: moneySchema(),
    currency: { type: 'string' },
    conditionCode: { type: ['string', 'null'] },
    agreementDate: dateTime,
    startDate: dateTime,
    endDate: dateTime,
    minStockLevel: { type: 'integer', minimum: 0 },
    reorderPoint: { type: 'integer', minimum: 0 },
    reorderQuantity: { type: 'integer', minimum: 0 },
    settlementTerms: { type: 'string', enum: ['MONTHLY', 'WEEKLY', 'PER_CONSUMPTION', 'QUARTERLY'] },
    paymentTerms: { type: ['string', 'null'] },
    commissionRate: { type: ['number', 'null'], minimum: 0 },
    initialQuantity: { type: 'integer', minimum: 0 },
    consumedQuantity: { type: 'integer', minimum: 0 },
    returnedQuantity: { type: 'integer', minimum: 0 },
    currentQuantity: { type: 'integer', minimum: 0 },
    lastSettlementDate: { type: ['string', 'null'], format: 'date-time' },
    nextSettlementDate: { type: ['string', 'null'], format: 'date-time' },
    isOverdue: { type: 'boolean' },
    daysUntilExpiry: { type: ['integer', 'null'] },
    inventoryId: { type: ['string', 'null'] },
    orderIds: { type: ['string', 'null'] },
    createdBy: id,
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'agreementNumber', 'title', 'status', 'supplierId', 'supplierName', 'partNumber', 'quantity', 'unitCost', 'currency', 'agreementDate', 'startDate', 'endDate', 'minStockLevel', 'reorderPoint', 'reorderQuantity', 'settlementTerms', 'initialQuantity', 'consumedQuantity', 'returnedQuantity', 'currentQuantity', 'isOverdue', 'createdBy', 'createdAt', 'updatedAt']);
  const fmvStage = coreResourceSchema({
    stage: { type: 'integer', minimum: 1 },
    stageName: { type: 'string' },
    fmv: { type: 'number', minimum: 0 },
    currency: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    dataPoints: { type: 'integer', minimum: 0 },
    method: { type: 'string' },
  }, ['stage', 'stageName', 'fmv', 'currency', 'confidence', 'dataPoints', 'method']);
  const fmv = coreResourceSchema({
    partNumber: { type: 'string' },
    manufacturer: { type: ['string', 'null'] },
    conditionCode: { type: 'string' },
    fmvs: { type: 'array', items: fmvStage },
    selectedFMV: { type: 'number', minimum: 0 },
    selectedStage: { type: 'integer', minimum: 0 },
    selectedConfidence: { type: 'number', minimum: 0, maximum: 100 },
    currency: { type: 'string' },
    calculatedAt: dateTime,
  }, ['partNumber', 'conditionCode', 'fmvs', 'selectedFMV', 'selectedStage', 'selectedConfidence', 'currency', 'calculatedAt']);
  const fmvHistory = coreResourceSchema({
    partNumber: { type: 'string' },
    history: { type: 'array', items: { type: 'object', required: ['date', 'price', 'quantity', 'source'], properties: { date: dateTime, price: { type: 'number', minimum: 0 }, quantity: { type: 'integer', minimum: 0 }, source: { type: 'string', enum: ['quotation', 'order'] } }, additionalProperties: false } },
    count: { type: 'integer', minimum: 0 },
  }, ['partNumber', 'history', 'count']);
  const exchange = coreResourceSchema({
    id,
    quoteId: { type: 'string' },
    coreCharge: moneySchema(),
    coreReturned: { type: 'boolean' },
    returnDeadline: { type: 'integer', minimum: 0 },
    coreEvaluationCriteria: { type: 'string' },
    acceptableDamageRange: { type: 'string' },
  }, ['id', 'quoteId', 'coreCharge', 'coreReturned', 'returnDeadline', 'coreEvaluationCriteria', 'acceptableDamageRange']);
  const vmiAgreement = coreResourceSchema({
    id,
    customerName: { type: 'string' },
    partNumber: { type: 'string' },
    minStock: { type: 'integer', minimum: 0 },
    maxStock: { type: 'integer', minimum: 0 },
    reorderPoint: { type: 'integer', minimum: 0 },
    reorderQty: { type: 'integer', minimum: 0 },
    consumptionData: { type: 'array', items: { type: 'object', required: ['month', 'quantity'], properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, quantity: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  }, ['id', 'customerName', 'partNumber', 'minStock', 'maxStock', 'reorderPoint', 'reorderQty', 'consumptionData']);
  const restockSuggestion = coreResourceSchema({
    id,
    partNumber: { type: 'string' },
    customerName: { type: 'string' },
    currentStock: { type: 'integer', minimum: 0 },
    suggestedQty: { type: 'integer', minimum: 0 },
    reason: { type: 'string' },
    expectedDeliveryDate: dateTime,
  }, ['id', 'partNumber', 'customerName', 'currentStock', 'suggestedQty', 'reason', 'expectedDeliveryDate']);
  const exchangeVmiStats = coreResourceSchema({
    activeExchanges: { type: 'integer', minimum: 0 },
    pendingCoreReturns: { type: 'integer', minimum: 0 },
    totalCoreDeposit: moneySchema(),
    monthlySettlement: moneySchema(),
    vmiCustomers: { type: 'integer', minimum: 0 },
    vmiPartNumbers: { type: 'integer', minimum: 0 },
    pendingRestock: { type: 'integer', minimum: 0 },
    totalVmiInventoryValue: moneySchema(),
  }, ['activeExchanges', 'pendingCoreReturns', 'totalCoreDeposit', 'monthlySettlement', 'vmiCustomers', 'vmiPartNumbers', 'pendingRestock', 'totalVmiInventoryValue']);
  const workflowAction = coreResourceSchema({
    id,
    instanceId: id,
    instanceStepId: { type: ['string', 'null'] },
    actionType: { type: 'string', enum: ['APPROVE', 'REJECT', 'TRANSFER', 'COMMENT', 'ESCALATE', 'AUTO_ACTION'] },
    actorId: id,
    actorRole: { type: ['string', 'null'] },
    actorName: { type: ['string', 'null'] },
    comment: { type: ['string', 'null'] },
    payload: { type: 'object', additionalProperties: true },
    createdAt: dateTime,
  }, ['id', 'instanceId', 'actionType', 'actorId', 'payload', 'createdAt']);
  const workflowStep = coreResourceSchema({
    id,
    workflowId: id,
    name: { type: 'string' },
    stepOrder: { type: 'integer', minimum: 1 },
    stepType: { type: 'string', enum: ['APPROVAL', 'NOTIFICATION', 'CONDITION', 'AUTOMATION'] },
    approverRole: { type: ['string', 'null'] },
    approverUserId: { type: ['string', 'null'] },
    approverDepartment: { type: ['string', 'null'] },
    agentId: { type: ['string', 'null'] },
    isParallel: { type: 'boolean' },
    parallelMinCount: { type: ['integer', 'null'], minimum: 0 },
    timeoutHours: { type: 'integer', minimum: 1 },
    timeoutAction: { type: 'string', enum: ['ESCALATE', 'AUTO_APPROVE', 'AUTO_REJECT'] },
    conditionExpression: { type: ['string', 'null'] },
    autoAction: { type: ['string', 'null'] },
    notificationTemplate: { type: ['string', 'null'] },
    createdAt: dateTime,
  }, ['id', 'workflowId', 'name', 'stepOrder', 'stepType', 'isParallel', 'timeoutHours', 'timeoutAction', 'createdAt']);
  const workflowDefinition = coreResourceSchema({
    id,
    name: { type: 'string' },
    code: { type: 'string' },
    description: { type: ['string', 'null'] },
    entityType: { type: 'string' },
    isActive: { type: 'boolean' },
    isDefault: { type: 'boolean' },
    version: { type: 'integer', minimum: 1 },
    createdAt: dateTime,
    updatedAt: dateTime,
    steps: { type: 'array', items: workflowStep },
    instanceCount: { type: 'integer', minimum: 0 },
  }, ['id', 'name', 'code', 'entityType', 'isActive', 'isDefault', 'version', 'createdAt', 'updatedAt', 'steps']);
  const workflowInstanceStep = coreResourceSchema({
    id,
    instanceId: id,
    stepId: id,
    stepOrder: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'SKIPPED', 'TIMEOUT'] },
    assignedTo: { type: ['string', 'null'] },
    assignedRole: { type: ['string', 'null'] },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    dueAt: { type: ['string', 'null'], format: 'date-time' },
    result: { type: ['string', 'null'] },
    step: { oneOf: [workflowStep, { type: 'object', additionalProperties: true }] },
    actions: { type: 'array', items: workflowAction },
  }, ['id', 'instanceId', 'stepId', 'stepOrder', 'status']);
  const workflowInstance = coreResourceSchema({
    id,
    definitionId: id,
    entityType: { type: 'string' },
    entityId: id,
    status: { type: 'string', enum: ['RUNNING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'TIMEOUT'] },
    currentStepId: { type: ['string', 'null'] },
    startedAt: dateTime,
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    startedBy: id,
    context: { type: 'object', additionalProperties: true },
    definition: { oneOf: [workflowDefinition, { type: 'object', additionalProperties: true }] },
    steps: { type: 'array', items: workflowInstanceStep },
    actions: { type: 'array', items: workflowAction },
  }, ['id', 'definitionId', 'entityType', 'entityId', 'status', 'startedAt', 'startedBy', 'context', 'steps', 'actions']);
  const workflowStepRequest = {
    type: 'object',
    required: ['name', 'stepOrder'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string', minLength: 1 },
      stepOrder: { type: 'integer', minimum: 1 },
      stepType: { type: 'string', enum: ['APPROVAL', 'NOTIFICATION', 'CONDITION', 'AUTOMATION'], default: 'APPROVAL' },
      approverRole: { type: 'string' },
      approverUserId: { type: 'string' },
      approverDepartment: { type: 'string' },
      isParallel: { type: 'boolean', default: false },
      parallelMinCount: { type: 'integer', minimum: 0 },
      timeoutHours: { type: 'integer', minimum: 1, default: 24 },
      timeoutAction: { type: 'string', enum: ['ESCALATE', 'AUTO_APPROVE', 'AUTO_REJECT'], default: 'ESCALATE' },
      conditionExpression: { type: 'string' },
      autoAction: { type: 'string' },
      notificationTemplate: { type: 'string' },
    },
    additionalProperties: false,
  };
  const integrityMetadata = coreResourceSchema({
    method: { type: 'string', enum: ['sha256_linked_records'] },
    storageScope: { type: 'string', enum: ['internal_database'] },
    externalTrustAnchor: { const: false },
    decisionBoundary: { type: 'string' },
  }, ['method', 'storageScope', 'externalTrustAnchor', 'decisionBoundary']);
  const blockchainRecord = coreResourceSchema({
    id,
    index: { type: 'integer', minimum: 0 },
    timestamp: dateTime,
    certificateId: { type: 'string' },
    certificateHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    previousHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    nonce: { type: 'integer', minimum: 0 },
  }, ['index', 'timestamp', 'certificateId', 'certificateHash', 'previousHash', 'hash', 'nonce']);
  const blockchainCertificateVerification = coreResourceSchema({
    verified: { type: 'boolean' },
    block: { oneOf: [blockchainRecord, { type: 'null' }] },
    certificateHash: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
    integrity: integrityMetadata,
  }, ['verified', 'integrity']);
  const blockchainChainVerification = coreResourceSchema({
    valid: { type: 'boolean' },
    blocksChecked: { type: 'integer', minimum: 0 },
    invalidBlocks: { type: 'array', items: { type: 'object', required: ['index', 'reason'], properties: { index: { type: 'integer', minimum: 0 }, reason: { type: 'string' } }, additionalProperties: false } },
    integrity: integrityMetadata,
  }, ['valid', 'blocksChecked', 'invalidBlocks', 'integrity']);
  const blockchainStats = coreResourceSchema({
    totalBlocks: { type: 'integer', minimum: 0 },
    totalCertificates: { type: 'integer', minimum: 0 },
    lastBlockTime: { type: ['string', 'null'], format: 'date-time' },
    chainValid: { type: 'boolean' },
    integrity: integrityMetadata,
  }, ['totalBlocks', 'totalCertificates', 'lastBlockTime', 'chainValid', 'integrity']);
  const blockchainRecordList = coreResourceSchema({
    records: { type: 'array', items: blockchainRecord },
    total: { type: 'integer', minimum: 0 },
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1 },
    totalPages: { type: 'integer', minimum: 0 },
  }, ['records', 'total', 'page', 'limit', 'totalPages']);
  const blockchainHash = coreResourceSchema({
    certificateId: id,
    hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  }, ['certificateId', 'hash']);
  const agentRuntimeStep = coreResourceSchema({
    id,
    capability: { type: 'string', enum: ['email', 'rfq', 'sourcing', 'supplierQuote', 'quotation', 'approval', 'order', 'notification'] },
    action: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'skipped'] },
    result: { type: ['object', 'null'], additionalProperties: true },
    error: { type: ['string', 'null'] },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
  }, ['id', 'capability', 'action', 'params', 'status']);
  const agentRuntimeConfirmationOption = coreResourceSchema({
    id,
    label: { type: 'string' },
    labelZh: { type: ['string', 'null'] },
    labelEn: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    descriptionZh: { type: ['string', 'null'] },
    descriptionEn: { type: ['string', 'null'] },
    action: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
  }, ['id', 'label', 'action']);
  const agentRuntimeConfirmation = coreResourceSchema({
    id,
    taskId: id,
    stepId: id,
    type: { type: 'string', enum: ['rfq_confirm', 'supplier_select', 'quotation_confirm', 'approval_confirm'] },
    title: { type: 'string' },
    titleZh: { type: ['string', 'null'] },
    titleEn: { type: ['string', 'null'] },
    description: { type: 'string' },
    descriptionZh: { type: ['string', 'null'] },
    descriptionEn: { type: ['string', 'null'] },
    data: { type: 'object', additionalProperties: true },
    options: { type: 'array', items: agentRuntimeConfirmationOption },
    selectedOption: { type: ['string', 'null'] },
    confirmedAt: { type: ['string', 'null'], format: 'date-time' },
    confirmedBy: { type: ['string', 'null'] },
  }, ['id', 'taskId', 'stepId', 'type', 'title', 'description', 'data', 'options']);
  const agentRuntimeTask = coreResourceSchema({
    id,
    trigger: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['email', 'manual', 'scheduled', 'system'] }, source: { type: 'string' }, referenceId: { type: 'string' } }, additionalProperties: false },
    type: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'running', 'waiting_confirmation', 'completed', 'failed', 'cancelled'] },
    currentStepIndex: { type: 'integer', minimum: 0 },
    steps: { type: 'array', items: agentRuntimeStep },
    confirmationNode: { oneOf: [agentRuntimeConfirmation, { type: 'null' }] },
    context: { type: 'object', additionalProperties: true },
    result: { type: ['object', 'null'], additionalProperties: true },
    createdAt: dateTime,
    updatedAt: dateTime,
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    error: { type: ['string', 'null'] },
  }, ['id', 'trigger', 'type', 'status', 'currentStepIndex', 'steps', 'context', 'createdAt', 'updatedAt']);
  const agent = coreResourceSchema({
    id,
    name: { type: 'string' },
    type: { type: 'string' },
    description: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    config: { type: 'object', additionalProperties: true },
    prompts: { type: 'array', items: {} },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'name', 'type', 'isActive', 'config', 'prompts', 'createdAt', 'updatedAt']);
  const agentLog = coreResourceSchema({
    id,
    agentId: id,
    action: { type: 'string' },
    input: { type: ['string', 'null'] },
    output: { type: ['string', 'null'] },
    status: { type: 'string' },
    error: { type: ['string', 'null'] },
    duration: { type: ['integer', 'null'], minimum: 0 },
    createdAt: dateTime,
  }, ['id', 'agentId', 'action', 'status', 'createdAt']);
  const aiModel = coreResourceSchema({
    id,
    name: { type: 'string' },
    provider: { type: 'string', enum: ['openai', 'anthropic', 'azure', 'ollama', 'deepseek', 'custom'] },
    modelId: { type: 'string' },
    baseUrl: { type: ['string', 'null'], format: 'uri' },
    isActive: { type: 'boolean' },
    isDefault: { type: 'boolean' },
    config: { type: 'object', additionalProperties: true },
    capabilities: { type: 'array', items: { type: 'string' } },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'name', 'provider', 'modelId', 'isActive', 'isDefault', 'config', 'capabilities', 'createdAt', 'updatedAt']);
  const agentRuntimeDashboard = coreResourceSchema({
    tasks: { type: 'object', required: ['total', 'running', 'pending', 'waitingConfirmation', 'completedToday', 'failedToday'], properties: { total: { type: 'integer', minimum: 0 }, running: { type: 'integer', minimum: 0 }, pending: { type: 'integer', minimum: 0 }, waitingConfirmation: { type: 'integer', minimum: 0 }, completedToday: { type: 'integer', minimum: 0 }, failedToday: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    recentTasks: { type: 'array', items: agentRuntimeTask },
    pendingConfirmations: { type: 'array', items: agentRuntimeConfirmation },
  }, ['tasks', 'recentTasks', 'pendingConfirmations']);
  const aiParsedEmail = coreResourceSchema({
    type: { type: 'string', enum: ['AOG', 'STANDARD', 'INQUIRY', 'SPAM'] },
    partNumbers: { type: 'array', items: { type: 'string' } },
    quantities: { type: 'array', items: { type: 'integer', minimum: 0 } },
    urgency: { type: 'string', enum: ['AOG', 'URGENT', 'STANDARD'] },
    aircraftType: { type: ['string', 'null'] },
  }, ['type', 'partNumbers', 'quantities', 'urgency']);
  const aiQuoteAnalysis = coreResourceSchema({ analysis: { type: 'string' } }, ['analysis']);
  const aiGeneratedEmail = coreResourceSchema({ email: { type: 'string' } }, ['email']);
  const aiCompletion = coreResourceSchema({
    content: { type: 'string' },
    model: { type: 'string' },
    usage: { oneOf: [{ type: 'object', properties: { promptTokens: { type: 'integer', minimum: 0 }, completionTokens: { type: 'integer', minimum: 0 }, totalTokens: { type: 'integer', minimum: 0 } }, additionalProperties: false }, { type: 'null' }] },
    latency: { type: 'integer', minimum: 0 },
  }, ['content', 'model', 'latency']);
  const auctionBid = coreResourceSchema({
    id,
    auctionId: id,
    bidderId: id,
    bidderType: { type: 'string', enum: ['user', 'supplier'] },
    bidderName: { type: 'string' },
    amount: { type: ['number', 'null'], minimum: 0 },
    currency: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
    isAutoBid: { type: 'boolean' },
    maxAutoBid: { type: ['number', 'null'], minimum: 0 },
    bidTime: dateTime,
    isWinning: { type: 'boolean' },
    isSealed: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }, ['id', 'auctionId', 'bidderId', 'bidderType', 'bidderName', 'amount', 'currency', 'quantity', 'isAutoBid', 'bidTime', 'isSealed']);
  const auction = coreResourceSchema({
    id,
    auctionNumber: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    type: { type: 'string', enum: ['sales', 'reverse', 'sealed'] },
    status: { type: 'string', enum: ['draft', 'active', 'closed', 'cancelled'] },
    partNumber: { type: 'string' },
    partDescription: { type: ['string', 'null'] },
    quantity: { type: 'integer', minimum: 1 },
    conditionCode: { type: ['string', 'null'] },
    certificateType: { type: ['string', 'null'] },
    startingPrice: { type: ['number', 'null'], minimum: 0 },
    reservePrice: { type: ['number', 'null'], minimum: 0 },
    buyNowPrice: { type: ['number', 'null'], minimum: 0 },
    currency: { type: 'string' },
    startAt: dateTime,
    endAt: dateTime,
    autoExtend: { type: 'boolean' },
    extendMinutes: { type: 'integer', minimum: 0 },
    sellerId: { type: ['string', 'null'] },
    buyerId: { type: ['string', 'null'] },
    invitedSupplierIds: { type: 'array', items: id },
    winnerBidId: { type: ['string', 'null'] },
    finalPrice: { type: ['number', 'null'], minimum: 0 },
    closedAt: { type: ['string', 'null'], format: 'date-time' },
    closedReason: { type: ['string', 'null'] },
    inventoryId: { type: ['string', 'null'] },
    rfqId: { type: ['string', 'null'] },
    createdBy: id,
    createdAt: dateTime,
    updatedAt: dateTime,
    bidCount: { type: 'integer', minimum: 0 },
    latestBid: { oneOf: [auctionBid, { type: 'null' }] },
    myBidCount: { type: 'integer', minimum: 0 },
    myLatestBid: { oneOf: [auctionBid, { type: 'null' }] },
  }, ['id', 'auctionNumber', 'title', 'type', 'status', 'partNumber', 'startAt', 'endAt', 'createdAt']);
  const auctionDetail = coreResourceSchema({
    ...auction.properties,
    bids: { type: 'array', items: auctionBid },
  }, [...auction.required, 'bids']);
  const auctionAction = coreResourceSchema({
    id,
    auctionNumber: { type: 'string' },
    status: { type: 'string', enum: ['draft', 'active', 'closed', 'cancelled'] },
    startAt: { type: ['string', 'null'], format: 'date-time' },
    endAt: { type: ['string', 'null'], format: 'date-time' },
    closedAt: { type: ['string', 'null'], format: 'date-time' },
    closedReason: { type: ['string', 'null'] },
    winnerBidId: { type: ['string', 'null'] },
    finalPrice: { type: ['number', 'null'], minimum: 0 },
  }, ['id', 'auctionNumber', 'status']);
  const auctionBidResult = coreResourceSchema({
    ...auctionBid.properties,
    endAtExtended: { type: 'boolean' },
    endAt: dateTime,
  }, [...auctionBid.required, 'endAtExtended', 'endAt']);
  const documentTemplate = coreResourceSchema({
    id,
    name: { type: 'string' },
    code: { type: 'string' },
    documentType: { type: 'string' },
    description: { type: ['string', 'null'] },
    bodyTemplate: { type: 'string' },
    headerTemplate: { type: ['string', 'null'] },
    footerTemplate: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    isDefault: { type: 'boolean' },
    version: { type: 'integer', minimum: 1 },
    createdAt: dateTime,
    updatedAt: dateTime,
    createdById: { type: ['string', 'null'] },
  }, ['id', 'name', 'code', 'documentType', 'bodyTemplate', 'isActive', 'isDefault', 'version', 'createdAt', 'updatedAt']);
  const generatedDocument = coreResourceSchema({
    id,
    templateId: { type: ['string', 'null'] },
    templateName: { type: ['string', 'null'] },
    quotationId: { type: ['string', 'null'] },
    orderId: { type: ['string', 'null'] },
    customerId: { type: ['string', 'null'] },
    documentType: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    contentHtml: { type: 'string' },
    generatedAt: dateTime,
    generatedById: { type: ['string', 'null'] },
  }, ['id', 'documentType', 'title', 'status', 'generatedAt']);
  const certificateTemplate = coreResourceSchema({
    id,
    name: { type: 'string' },
    code: { type: 'string' },
    certificateType: { type: 'string' },
    description: { type: ['string', 'null'] },
    bodyTemplate: { type: 'string' },
    headerTemplate: { type: ['string', 'null'] },
    footerTemplate: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    isDefault: { type: 'boolean' },
    version: { type: 'integer', minimum: 1 },
    createdAt: dateTime,
    updatedAt: dateTime,
    createdById: { type: ['string', 'null'] },
  }, ['id', 'name', 'code', 'certificateType', 'bodyTemplate', 'isActive', 'isDefault', 'version', 'createdAt', 'updatedAt']);
  const certificate = coreResourceSchema({
    id,
    certificateNumber: { type: 'string' },
    templateId: { type: ['string', 'null'] },
    templateName: { type: ['string', 'null'] },
    inventoryId: { type: ['string', 'null'] },
    inventoryDetailId: { type: ['string', 'null'] },
    orderId: { type: ['string', 'null'] },
    supplierId: { type: ['string', 'null'] },
    quotationId: { type: ['string', 'null'] },
    partNumber: { type: 'string' },
    serialNumber: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    quantity: { type: ['integer', 'null'], minimum: 0 },
    conditionCode: { type: ['string', 'null'] },
    certificateType: { type: 'string' },
    issueDate: dateTime,
    expiryDate: { type: ['string', 'null'], format: 'date-time' },
    issuedBy: { type: 'string' },
    issuedById: { type: 'string' },
    issuerCompany: { type: ['string', 'null'] },
    issuerAddress: { type: ['string', 'null'] },
    issuerCertNo: { type: ['string', 'null'] },
    status: { type: 'string' },
    qrCodeData: { type: ['string', 'null'] },
    verificationUrl: { type: ['string', 'null'] },
    fileUrl: { type: ['string', 'null'] },
    fileHash: { type: ['string', 'null'] },
    traceHistory: { type: 'array', items: { type: 'object', additionalProperties: true } },
    parentCertificateId: { type: ['string', 'null'] },
    countryOfOrigin: { type: ['string', 'null'] },
    manufactureDate: { type: ['string', 'null'], format: 'date-time' },
    batchNumber: { type: ['string', 'null'] },
    ataChapter: { type: ['string', 'null'] },
    aircraftModel: { type: ['string', 'null'] },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'certificateNumber', 'partNumber', 'certificateType', 'issueDate', 'issuedBy', 'issuedById', 'status', 'createdAt', 'updatedAt']);
  const webhookEndpoint = coreResourceSchema({
    id,
    name: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    method: { type: 'string', enum: ['POST', 'PUT'] },
    authType: { type: 'string', enum: ['none', 'bearer'] },
    customHeaders: { type: 'object', additionalProperties: { type: 'string' } },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
    maxRetries: { type: 'integer', minimum: 0, maximum: 10 },
    isActive: { type: 'boolean' },
    lastSuccessAt: { type: ['string', 'null'], format: 'date-time' },
    lastFailureAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: dateTime,
    updatedAt: dateTime,
    subscriptions: { type: 'array', items: schemaRef('WebhookSubscription') },
  }, ['id', 'name', 'url', 'method', 'authType', 'timeoutMs', 'maxRetries', 'isActive']);
  const webhookSubscription = coreResourceSchema({
    id,
    endpointId: id,
    eventTypes: { type: 'array', items: { type: 'string' } },
    filters: { type: 'object', additionalProperties: true },
    isActive: { type: 'boolean' },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'endpointId', 'eventTypes', 'isActive']);
  const webhookDelivery = coreResourceSchema({
    id,
    endpointId: id,
    eventId: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'string' },
    status: { type: 'string' },
    attemptCount: { type: 'integer', minimum: 0 },
    responseStatus: { type: ['integer', 'null'] },
    responseBody: { type: ['string', 'null'] },
    lastError: { type: ['string', 'null'] },
    nextRetryAt: { type: ['string', 'null'], format: 'date-time' },
    workerId: { type: ['string', 'null'] },
    deliveredAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'endpointId', 'eventId', 'eventType', 'status', 'attemptCount']);
  const inboundEndpoint = coreResourceSchema({
    id,
    name: { type: 'string' },
    sourceSystem: { type: 'string' },
    urlPath: { type: 'string' },
    authMethod: { type: 'string' },
    isActive: { type: 'boolean' },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'name', 'sourceSystem', 'urlPath', 'authMethod', 'isActive']);
  const inboundDelivery = coreResourceSchema({
    id,
    endpointId: id,
    payload: { type: 'string' },
    status: { type: 'string' },
    errorMessage: { type: ['string', 'null'] },
    receivedAt: dateTime,
    processedAt: { type: ['string', 'null'], format: 'date-time' },
  }, ['id', 'endpointId', 'payload', 'status', 'receivedAt']);
  const outboxEvent = coreResourceSchema({
    id,
    channel: { type: 'string' },
    eventType: { type: 'string' },
    aggregateType: { type: 'string' },
    aggregateId: { type: 'string' },
    status: { type: 'string' },
    attemptCount: { type: 'integer', minimum: 0 },
    maxAttempts: { type: 'integer', minimum: 0 },
    nextRetryAt: { type: ['string', 'null'], format: 'date-time' },
    lockedAt: { type: ['string', 'null'], format: 'date-time' },
    workerId: { type: ['string', 'null'] },
    deliveredAt: { type: ['string', 'null'], format: 'date-time' },
    lastError: { type: ['string', 'null'] },
    createdById: { type: ['string', 'null'] },
    requestId: { type: ['string', 'null'] },
    createdAt: dateTime,
    updatedAt: dateTime,
  }, ['id', 'channel', 'eventType', 'aggregateType', 'aggregateId', 'status', 'attemptCount', 'maxAttempts', 'createdAt', 'updatedAt']);
  const notification = coreResourceSchema({
    id,
    userId: { type: ['string', 'null'] },
    title: { type: 'string' },
    message: { type: 'string' },
    type: { type: 'string' },
    isRead: { type: 'boolean' },
    link: { type: ['string', 'null'] },
    createdAt: dateTime,
  }, ['id', 'title', 'message', 'type', 'isRead', 'createdAt']);
  const dashboardStats = coreResourceSchema({
    pendingRFQs: { type: 'integer', minimum: 0 },
    pendingQuotes: { type: 'integer', minimum: 0 },
    pendingApprovals: { type: 'integer', minimum: 0 },
    weeklyRevenue: moneySchema(),
    rfqTrend: { type: 'integer' },
    quoteTrend: { type: 'integer' },
    approvalTrend: { type: 'integer' },
    revenueTrend: { type: 'integer' },
  }, ['pendingRFQs', 'pendingQuotes', 'pendingApprovals', 'weeklyRevenue', 'rfqTrend', 'quoteTrend', 'approvalTrend', 'revenueTrend']);
  const dashboardFunnelItem = coreResourceSchema({ stage: { type: 'string' }, count: { type: 'integer', minimum: 0 }, amount: moneySchema() }, ['stage', 'count', 'amount']);
  const dashboardActivity = coreResourceSchema({ id, type: { type: 'string', enum: ['rfq', 'quote', 'order'] }, description: { type: 'string' }, timestamp: dateTime }, ['id', 'type', 'description', 'timestamp']);
  const availability = coreResourceSchema({
    status: { type: 'string', enum: ['available', 'insufficient_data', 'unavailable'] },
    source: { type: 'string' },
    algorithmVersion: { type: ['string', 'null'] },
    sampleSize: { type: 'integer', minimum: 0 },
    asOf: dateTime,
    reason: { type: 'string' },
    decisionBoundary: { type: 'string' },
  }, ['status', 'source', 'algorithmVersion', 'sampleSize', 'asOf', 'decisionBoundary']);
  const reportSummary = coreResourceSchema({
    rfqsThisMonth: { type: 'integer', minimum: 0 }, rfqTrend: { type: ['integer', 'null'] },
    quotesThisMonth: { type: 'integer', minimum: 0 }, quoteTrend: { type: ['integer', 'null'] },
    ordersThisMonth: { type: 'integer', minimum: 0 }, orderTrend: { type: ['integer', 'null'] },
    revenueThisMonth: moneySchema(), revenueTrend: { type: ['integer', 'null'] },
    activeCustomers: { type: 'integer', minimum: 0 }, customerRetention: { type: ['number', 'null'] },
    avgCustomerValue: { type: ['number', 'null'] }, totalInventoryValue: moneySchema(),
    avgTurnoverDays: { type: ['number', 'null'] }, slowMovingValue: { type: ['number', 'null'] },
    slowMovingShare: { type: ['number', 'null'] }, inventoryAlerts: { type: 'integer', minimum: 0 }, metadata: availability,
  }, ['rfqsThisMonth', 'quotesThisMonth', 'ordersThisMonth', 'revenueThisMonth', 'activeCustomers', 'totalInventoryValue', 'inventoryAlerts', 'metadata']);
  const reportSalesTrendItem = coreResourceSchema({ month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, rfqs: { type: 'integer', minimum: 0 }, quotes: { type: 'integer', minimum: 0 }, orders: { type: 'integer', minimum: 0 }, revenue: moneySchema() }, ['month', 'rfqs', 'quotes', 'orders', 'revenue']);
  const reportConversion = coreResourceSchema({ overallRate: { type: ['number', 'null'] }, avgOrderValue: { type: ['number', 'null'] }, avgMargin: { type: ['number', 'null'] }, avgResponseTime: { type: ['number', 'null'] }, lostReasons: { type: 'array', items: { type: 'string' } }, metadata: availability }, ['overallRate', 'avgOrderValue', 'avgMargin', 'avgResponseTime', 'lostReasons', 'metadata']);
  const reportCustomerContribution = coreResourceSchema({ name: { type: 'string' }, value: moneySchema() }, ['name', 'value']);
  const reportInventoryTurnoverItem = coreResourceSchema({ category: { type: 'string' }, days: { type: ['number', 'null'] }, target: { type: ['number', 'null'] }, sampleSize: { type: 'integer', minimum: 0 } }, ['category', 'days', 'target', 'sampleSize']);
  const upload = coreResourceSchema({ id, filename: { type: 'string' }, originalName: { type: 'string' }, size: { type: 'integer', minimum: 1 }, mimetype: { type: 'string' }, url: { type: 'string' }, downloadUrl: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, version: { type: 'integer', minimum: 1 } }, ['id', 'filename', 'originalName', 'size', 'mimetype', 'downloadUrl', 'sha256', 'version']);
  const inventoryDetail = coreResourceSchema({
    id, inventoryItemId: id, serialNumber: { type: ['string', 'null'] }, batchNumber: { type: ['string', 'null'] },
    quantity: { type: 'integer', minimum: 0 }, conditionCode: { type: 'string' }, status: { type: 'string' }, location: { type: 'string' },
    warehouse: { type: ['string', 'null'] }, shelf: { type: ['string', 'null'] }, certificateType: { type: 'string' }, unitCost: moneySchema(),
    type: { type: 'string' }, supplierId: { type: ['string', 'null'] }, createdAt: dateTime, updatedAt: dateTime,
  }, ['id', 'inventoryItemId', 'quantity', 'conditionCode', 'status', 'location', 'certificateType', 'unitCost', 'type', 'createdAt', 'updatedAt']);
  const inventoryItem = coreResourceSchema({
    id, partNumber: { type: 'string' }, description: { type: 'string' }, partCategory: { type: 'string' }, trackingType: { type: 'string' },
    manufacturer: { type: ['string', 'null'] }, manufacturerCageCode: { type: ['string', 'null'] }, ataChapter: { type: ['string', 'null'] },
    alternatePartNumbers: { type: ['string', 'null'] }, unitOfMeasure: { type: 'string' }, countryOfOrigin: { type: ['string', 'null'] },
    hsCode: { type: ['string', 'null'] }, createdAt: dateTime, updatedAt: dateTime,
    details: { type: 'array', items: inventoryDetail },
  }, ['id', 'partNumber', 'description', 'partCategory', 'trackingType', 'unitOfMeasure', 'createdAt', 'updatedAt']);
  const inventoryTransaction = coreResourceSchema({
    id, inventoryDetailId: id, type: { type: 'string' }, quantity: { type: 'integer' }, beforeQuantity: { type: 'integer' }, afterQuantity: { type: 'integer' },
    orderId: { type: ['string', 'null'] }, quotationId: { type: ['string', 'null'] }, referenceNo: { type: ['string', 'null'] }, referenceType: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] }, createdBy: id, createdAt: dateTime,
  }, ['id', 'inventoryDetailId', 'type', 'quantity', 'beforeQuantity', 'afterQuantity', 'createdBy', 'createdAt']);
  const shipmentEvent = coreResourceSchema({ timestamp: dateTime, location: { type: 'string' }, status: { type: 'string' }, description: { type: 'string' } }, ['timestamp', 'location', 'status', 'description']);
  const shipmentTracking = coreResourceSchema({ id, orderId: id, trackingNumber: { type: 'string' }, carrier: { type: 'string' }, origin: { type: 'string' }, destination: { type: 'string' }, status: { type: 'string' }, estimatedDelivery: { type: 'string' }, events: { type: 'array', items: shipmentEvent } }, ['id', 'orderId', 'trackingNumber', 'carrier', 'origin', 'destination', 'status', 'estimatedDelivery', 'events']);
  const shipmentRisk = coreResourceSchema({ partNumber: { type: 'string' }, hsCode: { type: 'string' }, riskLevel: { type: 'string', enum: ['high', 'medium', 'low'] }, inspectionRate: { type: 'number', minimum: 0, maximum: 100 }, requiredDocs: { type: 'array', items: { type: 'string' } }, recommendations: { type: 'array', items: { type: 'string' } } }, ['partNumber', 'hsCode', 'riskLevel', 'inspectionRate', 'requiredDocs', 'recommendations']);
  const shipmentAlert = coreResourceSchema({ id, type: { type: 'string', enum: ['delay', 'customs', 'resolved'] }, title: { type: 'string' }, description: { type: 'string' }, orderId: id, partNumber: { type: 'string' }, status: { type: 'string', enum: ['open', 'in_progress', 'resolved'] }, createdAt: dateTime }, ['id', 'type', 'title', 'description', 'orderId', 'partNumber', 'status', 'createdAt']);
  const inquiryItem = coreResourceSchema({ partNumber: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, requiredDate: dateTime, certificateRequired: { type: 'boolean' } }, ['partNumber', 'quantity', 'requiredDate', 'certificateRequired']);
  const inquiry = coreResourceSchema({ id, inquiryNumber: { type: 'string' }, supplierId: id, supplierName: { type: 'string' }, items: { type: 'array', items: inquiryItem }, isAOG: { type: 'boolean' }, status: { type: 'string' }, createdAt: dateTime, sentAt: { type: ['string', 'null'], format: 'date-time' } }, ['id', 'inquiryNumber', 'supplierId', 'supplierName', 'items', 'isAOG', 'status', 'createdAt']);
  const notificationPreference = coreResourceSchema({ id, userId: id, emailNotify: { type: 'boolean' }, systemNotify: { type: 'boolean' }, approvalNotify: { type: 'boolean' }, aogAlert: { type: 'boolean' }, weeklyReport: { type: 'boolean' }, wechatNotify: { type: 'boolean' }, dingtalkNotify: { type: 'boolean' }, larkNotify: { type: 'boolean' }, smsNotify: { type: 'boolean' }, pushNotify: { type: 'boolean' }, createdAt: dateTime, updatedAt: dateTime }, ['id', 'userId', 'emailNotify', 'systemNotify', 'approvalNotify', 'aogAlert', 'weeklyReport', 'wechatNotify', 'dingtalkNotify', 'larkNotify', 'smsNotify', 'pushNotify', 'createdAt', 'updatedAt']);
  const channelBinding = coreResourceSchema({ id, userId: id, channel: { type: 'string' }, config: { type: 'object', additionalProperties: { type: 'string' } }, isActive: { type: 'boolean' }, createdAt: dateTime, updatedAt: dateTime }, ['id', 'userId', 'channel', 'config', 'isActive', 'createdAt', 'updatedAt']);
  const resourceResponse = (description, schema) => ({
    description,
    content: { 'application/json': { schema: schemaRef(schema) } },
  });

  return {
    requestBodies,
    schemas: {
      Pagination: pagination,
      UserEnvelope: envelope(schemaRef('User')),
      User: authUser,
      ManagedUser: managedUser,
      ManagedUserEnvelope: envelope(schemaRef('ManagedUser')),
      ManagedUserListEnvelope: envelope({ type: 'array', items: schemaRef('ManagedUser') }),
      ManagedUserOnboarding: managedUserOnboarding,
      ManagedUserOnboardingEnvelope: envelope(schemaRef('ManagedUserOnboarding')),
      ManagedUserDelete: managedUserDelete,
      ManagedUserDeleteEnvelope: envelope(schemaRef('ManagedUserDelete')),
      ManagedUserCreateRequest: coreRequestSchema({
        name: { type: 'string', minLength: 1 },
        email: { type: 'string', format: 'email' },
        role: { type: 'string', minLength: 1, default: 'sales' },
        department: { type: 'string' },
      }, ['name', 'email']),
      ManagedUserUpdateRequest: coreRequestSchema({
        name: { type: 'string', minLength: 1 },
        email: { type: 'string', format: 'email' },
        role: { type: 'string', minLength: 1 },
        department: { type: 'string' },
        isActive: { type: 'boolean' },
        avatar: { type: 'string' },
      }),
      AuthLoginEnvelope: envelope({ type: 'object', required: ['token', 'user'], properties: { token: { type: 'string' }, user: schemaRef('User') } }),
      AuthRefreshEnvelope: envelope({ type: 'object', required: ['accessToken'], properties: { accessToken: { type: 'string' } } }),
      AuthLogoutEnvelope: envelope({ type: 'object', additionalProperties: true }),
      CapabilitiesEnvelope: envelope({ type: 'object', required: ['role', 'grants'], properties: { role: { type: 'string' }, grants: { type: 'array', items: { type: 'object', additionalProperties: true } } } }),
      SessionsEnvelope: envelope({ type: 'array', items: schemaRef('Session') }),
      Session: session,
      SessionRevokeAllEnvelope: envelope({ type: 'object', required: ['revokedSessions', 'tokenVersion'], properties: { revokedSessions: { type: 'integer', minimum: 0 }, tokenVersion: { type: 'integer', minimum: 0 } } }),
      SessionRevokeEnvelope: envelope({ type: 'object', required: ['id', 'revoked'], properties: { id, revoked: { type: 'boolean' } } }),
      SecurityEventsEnvelope: envelope({ type: 'array', items: schemaRef('SecurityEvent') }, { pagination: { type: 'object', required: ['limit', 'total'], properties: { limit: { type: 'integer' }, total: { type: 'integer' } } } }),
      SecurityEventEnvelope: envelope(schemaRef('SecurityEvent')),
      SecurityEvent: securityEvent,
      ActivationInfoEnvelope: envelope(schemaRef('ActivationInfo')),
      ActivationInfo: coreResourceSchema({ email: { type: 'string', format: 'email' }, name: { type: 'string' }, activationExpiresAt: dateTime }, ['email', 'name', 'activationExpiresAt']),
      ResetInfoEnvelope: envelope(schemaRef('ResetInfo')),
      ResetInfo: coreResourceSchema({ email: { type: 'string', format: 'email' }, name: { type: 'string' }, resetExpiresAt: dateTime }, ['email', 'name', 'resetExpiresAt']),
      MessageEnvelope: envelope({ type: 'object', required: ['message'], properties: { message: { type: 'string' } } }),
      ProfileUpdateRequest: coreRequestSchema({ name: { type: 'string' }, email: { type: 'string', format: 'email' }, department: { type: 'string' }, avatar: { type: 'string' } }),
      TokenPasswordRequest: coreRequestSchema({ token: { type: 'string', minLength: 1 }, password: { type: 'string', minLength: 8 } }, ['token', 'password']),
      ForgotPasswordRequest: coreRequestSchema({ email: { type: 'string', format: 'email' } }, ['email']),
      ChangePasswordRequest: coreRequestSchema({ currentPassword: { type: 'string', minLength: 1 }, newPassword: { type: 'string', minLength: 8 } }, ['currentPassword', 'newPassword']),
      EmailClassifyRequest: coreRequestSchema({ type: { type: 'string', enum: ['AOG', 'STANDARD', 'INQUIRY', 'SPAM'] } }, ['type']),
      EmailAccountCreateRequest: coreRequestSchema({
        email: { type: 'string', format: 'email' }, displayName: { type: 'string' }, imapServer: { type: 'string', minLength: 1 },
        imapPort: { type: 'string' }, smtpServer: { type: 'string', minLength: 1 }, smtpPort: { type: 'string' },
        authCode: { type: 'string', minLength: 1, writeOnly: true }, accountType: { type: 'string' }, isDefault: { type: 'boolean' }, syncInterval: { type: 'integer', minimum: 0 },
      }, ['email', 'imapServer', 'smtpServer', 'authCode']),
      EmailAccountUpdateRequest: coreRequestSchema({
        email: { type: 'string', format: 'email' }, displayName: { type: 'string' }, imapServer: { type: 'string', minLength: 1 },
        imapPort: { type: 'string' }, smtpServer: { type: 'string', minLength: 1 }, smtpPort: { type: 'string' },
        authCode: { type: 'string', minLength: 1, writeOnly: true }, accountType: { type: 'string' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, syncInterval: { type: 'integer', minimum: 0 },
      }),
      Email: email,
      EmailEnvelope: envelope(schemaRef('Email')),
      EmailListEnvelope: envelope({ type: 'array', items: schemaRef('Email') }, { pagination: schemaRef('Pagination') }),
      EmailAccount: emailAccount,
      EmailAccountEnvelope: envelope(schemaRef('EmailAccount')),
      EmailAccountListEnvelope: envelope({ type: 'array', items: schemaRef('EmailAccount') }, { pagination: schemaRef('Pagination') }),
      AuthEmailDelivery: authEmailDelivery,
      AuthEmailDeliveryEnvelope: envelope(schemaRef('AuthEmailDelivery')),
      EmailConnectionTestEnvelope: envelope({ type: 'object', required: ['imap', 'smtp'], properties: { imap: { type: 'boolean' }, smtp: { type: 'boolean' } } }),
      EmailSyncEnvelope: envelope({ type: 'object', required: ['syncedCount', 'fetchedCount', 'lastSyncAt'], properties: { syncedCount: { type: 'integer', minimum: 0 }, fetchedCount: { type: 'integer', minimum: 0 }, lastSyncAt: { type: 'string', format: 'date-time' } } }),
      DocumentTemplate: documentTemplate,
      DocumentTemplateListEnvelope: envelope({ type: 'array', items: schemaRef('DocumentTemplate') }, { meta: { type: 'object', additionalProperties: true } }),
      GeneratedDocument: generatedDocument,
      GeneratedDocumentListEnvelope: envelope({ type: 'array', items: schemaRef('GeneratedDocument') }),
      DocumentTemplateCreateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, code: { type: 'string', minLength: 1 }, documentType: { type: 'string' }, description: { type: 'string' }, bodyTemplate: { type: 'string', minLength: 1 }, headerTemplate: { type: 'string' }, footerTemplate: { type: 'string' }, isActive: { type: 'boolean', default: true }, isDefault: { type: 'boolean', default: false } }, ['name', 'code', 'bodyTemplate']),
      DocumentTemplateUpdateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, code: { type: 'string', minLength: 1 }, documentType: { type: 'string' }, description: { type: 'string' }, bodyTemplate: { type: 'string', minLength: 1 }, headerTemplate: { type: 'string' }, footerTemplate: { type: 'string' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, version: { type: 'integer', minimum: 1 } }),
      CertificateTemplate: certificateTemplate,
      CertificateTemplateListEnvelope: envelope({ type: 'array', items: schemaRef('CertificateTemplate') }, { pagination: schemaRef('Pagination') }),
      CertificateTemplateCreateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, code: { type: 'string', minLength: 1 }, certificateType: { type: 'string' }, description: { type: 'string' }, bodyTemplate: { type: 'string', minLength: 1 }, headerTemplate: { type: 'string' }, footerTemplate: { type: 'string' }, isActive: { type: 'boolean', default: true }, isDefault: { type: 'boolean', default: false } }, ['name', 'code', 'bodyTemplate']),
      CertificateTemplateUpdateRequest: coreRequestSchema({ name: { type: 'string' }, code: { type: 'string' }, certificateType: { type: 'string' }, description: { type: 'string' }, bodyTemplate: { type: 'string' }, headerTemplate: { type: 'string' }, footerTemplate: { type: 'string' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' } }),
      Certificate: certificate,
      CertificateListEnvelope: envelope({ type: 'array', items: schemaRef('Certificate') }, { pagination: schemaRef('Pagination') }),
      CertificateIssueRequest: coreRequestSchema({ templateId: id, inventoryId: id, inventoryDetailId: id, orderId: id, supplierId: id, quotationId: id, partNumber: { type: 'string', minLength: 1 }, serialNumber: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'integer', minimum: 0 }, conditionCode: { type: 'string' }, certificateType: { type: 'string' }, expiryDate: { type: 'string', format: 'date-time' }, issuedBy: { type: 'string' }, issuerCompany: { type: 'string' }, issuerAddress: { type: 'string' }, issuerCertNo: { type: 'string' }, countryOfOrigin: { type: 'string' }, manufactureDate: { type: 'string', format: 'date-time' }, batchNumber: { type: 'string' }, ataChapter: { type: 'string' }, aircraftModel: { type: 'string' } }, ['partNumber']),
      CertificateRevokeRequest: coreRequestSchema({ reason: { type: 'string' } }),
      CertificateRenewRequest: coreRequestSchema({ newExpiryDate: { type: 'string', format: 'date-time' }, reason: { type: 'string' } }, ['newExpiryDate']),
      CertificateVerificationEnvelope: envelope({ type: 'object', required: ['id', 'certificateNumber', 'status', 'isValid', 'isExpired'], properties: { id, certificateNumber: { type: 'string' }, status: { type: 'string' }, isValid: { type: 'boolean' }, isExpired: { type: 'boolean' }, daysUntilExpiry: { type: ['integer', 'null'] }, verificationTimestamp: dateTime }, additionalProperties: true }),
      CertificateActionEnvelope: envelope({ type: 'object', additionalProperties: true }),
      CertificateDownloadEnvelope: envelope({ type: 'object', additionalProperties: true }),
      CertificateExpiringEnvelope: envelope({ type: 'array', items: schemaRef('Certificate') }, { meta: { type: 'object', additionalProperties: true } }),
      WebhookEndpoint: webhookEndpoint,
      WebhookEndpointListEnvelope: envelope({ type: 'array', items: schemaRef('WebhookEndpoint') }),
      WebhookEndpointCreateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, url: { type: 'string', format: 'uri' }, method: { type: 'string', enum: ['POST', 'PUT'], default: 'POST' }, authType: { type: 'string', enum: ['none', 'bearer'], default: 'none' }, authToken: { type: 'string' }, secret: { type: 'string', minLength: 8 }, customHeaders: { type: 'object', additionalProperties: { type: 'string' } }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 10000 }, maxRetries: { type: 'integer', minimum: 0, maximum: 10, default: 3 }, isActive: { type: 'boolean', default: true } }, ['name', 'url']),
      WebhookEndpointUpdateRequest: coreRequestSchema({ name: { type: 'string' }, url: { type: 'string', format: 'uri' }, method: { type: 'string', enum: ['POST', 'PUT'] }, authType: { type: 'string', enum: ['none', 'bearer'] }, authToken: { type: 'string' }, secret: { type: 'string', minLength: 8 }, customHeaders: { type: 'object', additionalProperties: { type: 'string' } }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 }, maxRetries: { type: 'integer', minimum: 0, maximum: 10 }, isActive: { type: 'boolean' } }),
      WebhookSubscription: webhookSubscription,
      WebhookSubscriptionListEnvelope: envelope({ type: 'array', items: schemaRef('WebhookSubscription') }),
      WebhookSubscriptionReplaceRequest: coreRequestSchema({ eventTypes: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 } }, ['eventTypes']),
      WebhookDelivery: webhookDelivery,
      WebhookDeliveryListEnvelope: envelope({ type: 'array', items: schemaRef('WebhookDelivery') }, { pagination: schemaRef('Pagination') }),
      WebhookEventsEnvelope: envelope({ type: 'array', items: { type: 'string' } }),
      InboundEndpoint: inboundEndpoint,
      InboundEndpointListEnvelope: envelope({ type: 'array', items: schemaRef('InboundEndpoint') }),
      InboundEndpointCreateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, sourceSystem: { type: 'string', minLength: 1 }, urlPath: { type: 'string', minLength: 1 }, authMethod: { type: 'string', default: 'HMAC' }, secret: { type: 'string' }, isActive: { type: 'boolean', default: true } }, ['name', 'sourceSystem', 'urlPath']),
      InboundEndpointUpdateRequest: coreRequestSchema({ name: { type: 'string' }, sourceSystem: { type: 'string' }, authMethod: { type: 'string' }, secret: { type: 'string' } }),
      InboundDelivery: inboundDelivery,
      InboundDeliveryListEnvelope: envelope({ type: 'array', items: schemaRef('InboundDelivery') }, { pagination: { type: 'object', additionalProperties: true } }),
      WebhookAuditListEnvelope: envelope({ type: 'array', items: { type: 'object', additionalProperties: true } }, { pagination: { type: 'object', additionalProperties: true } }),
      InboundAcceptedEnvelope: envelope({ type: 'object', required: ['endpointId', 'deliveryId', 'status'], properties: { endpointId: id, deliveryId: id, status: { const: 'accepted' } } }),
      WebhookPhase2Response: { type: 'object', additionalProperties: true },
      WebhookPhase2Request: { type: 'object', additionalProperties: true },
      OutboxEvent: outboxEvent,
      OutboxListEnvelope: envelope({ type: 'array', items: schemaRef('OutboxEvent') }, { pagination: schemaRef('Pagination') }),
      OutboxStatsEnvelope: envelope({ type: 'object', additionalProperties: true }),
      OutboxActionEnvelope: envelope({ type: 'object', additionalProperties: true }),
      OutboxReplayRequest: coreRequestSchema({ confirm: { type: 'string', const: 'replay' } }, ['confirm']),
      OutboxCancelRequest: coreRequestSchema({ reason: { type: 'string' } }),
      Notification: notification,
      NotificationListEnvelope: envelope({ type: 'array', items: schemaRef('Notification') }),
      NotificationUnreadCountEnvelope: envelope({ type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 0 } } }),
      NotificationActionEnvelope: envelope({ type: 'object', required: ['message'], properties: { message: { type: 'string' } } }),
      NotificationDispatchRequest: coreRequestSchema({ event: { type: 'string' }, targetUserIds: { type: 'array', items: id, maxItems: 1000 }, payload: { type: 'object', additionalProperties: { type: 'string' } } }),
      NotificationDispatchEnvelope: envelope({ type: 'object', required: ['dispatched', 'channels'], properties: { dispatched: { type: 'integer', minimum: 0 }, channels: { type: 'array', items: { type: 'object', required: ['channel', 'count'], properties: { channel: { type: 'string' }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } } } }),
      DashboardStatsEnvelope: envelope(schemaRef('DashboardStats')),
      DashboardStats: dashboardStats,
      DashboardFunnelEnvelope: envelope({ type: 'array', items: schemaRef('DashboardFunnelItem') }),
      DashboardFunnelItem: dashboardFunnelItem,
      DashboardActivitiesEnvelope: envelope({ type: 'array', items: schemaRef('DashboardActivity') }),
      DashboardActivity: dashboardActivity,
      ReportSummary: reportSummary,
      ReportSalesTrend: { type: 'array', items: reportSalesTrendItem },
      ReportConversion: reportConversion,
      ReportCustomerContribution: { type: 'array', items: reportCustomerContribution },
      ReportInventoryTurnover: coreResourceSchema({ items: { type: 'array', items: reportInventoryTurnoverItem }, metadata: availability }, ['items', 'metadata']),
      UploadEnvelope: envelope(upload),
      UploadListEnvelope: envelope({ type: 'array', items: upload }),
      InventoryDetail: inventoryDetail,
      InventoryItem: inventoryItem,
      InventoryItemListRaw: { type: 'array', items: schemaRef('InventoryItem') },
      InventoryItemRaw: inventoryItem,
      InventoryItemCreateRequest: coreRequestSchema({ partNumber: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, partCategory: { type: 'string' }, trackingType: { type: 'string' }, manufacturer: { type: 'string' }, unitOfMeasure: { type: 'string' } }, ['partNumber', 'description']),
      InventoryItemUpdateRequest: coreRequestSchema({ partNumber: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, partCategory: { type: 'string' }, trackingType: { type: 'string' }, manufacturer: { type: 'string' }, unitOfMeasure: { type: 'string' } }),
      InventoryTransaction: inventoryTransaction,
      InventoryTransactionListEnvelope: envelope({ type: 'array', items: schemaRef('InventoryTransaction') }),
      InventoryTransactionActionEnvelope: envelope(coreResourceSchema({ ...inventoryTransaction.properties, inventoryStatus: { type: 'string' }, inventoryQuantity: { type: 'integer', minimum: 0 }, reservedQuantity: { type: 'integer', minimum: 0 }, releasedQuantity: { type: 'integer', minimum: 0 }, outboundQuantity: { type: 'integer', minimum: 0 }, outboundStatus: { type: 'string' }, orderStatus: { type: 'string' }, quotationVersion: { type: 'integer', minimum: 1 }, orderVersion: { type: 'integer', minimum: 1 } })),
      InventoryReserveRequest: coreRequestSchema({ inventoryDetailId: id, quotationId: id, quantity: { type: 'integer', minimum: 1 }, notes: { type: 'string' } }, ['inventoryDetailId', 'quotationId', 'quantity']),
      InventoryReleaseRequest: coreRequestSchema({ quotationId: id, notes: { type: 'string' } }, ['quotationId']),
      InventoryOutboundRequest: coreRequestSchema({ inventoryDetailId: id, orderId: id, quantity: { type: 'integer', minimum: 1 }, notes: { type: 'string' } }, ['inventoryDetailId', 'orderId', 'quantity']),
      ShipmentEvent: shipmentEvent,
      ShipmentTracking: shipmentTracking,
      ShipmentTrackingEnvelope: envelope({ oneOf: [schemaRef('ShipmentTracking'), { type: 'null' }] }),
      ShipmentTrackingListEnvelope: envelope({ type: 'array', items: schemaRef('ShipmentTracking') }),
      ShipmentCustomsRiskListEnvelope: envelope({ type: 'array', items: schemaRef('ShipmentCustomsRisk') }),
      ShipmentCustomsRisk: shipmentRisk,
      ShipmentAlertListEnvelope: envelope({ type: 'array', items: schemaRef('ShipmentAlert') }),
      ShipmentAlert: shipmentAlert,
      Inquiry: inquiry,
      InquiryEnvelope: envelope(schemaRef('Inquiry')),
      InquiryListEnvelope: envelope({ type: 'array', items: schemaRef('Inquiry') }),
      InquiryCreateRequest: coreRequestSchema({ rfqId: id, supplierIds: { type: 'array', items: id, minItems: 1, maxItems: 100 }, isAOG: { type: 'boolean' } }, ['rfqId', 'supplierIds']),
      NotificationPreference: notificationPreference,
      NotificationPreferenceEnvelope: envelope(schemaRef('NotificationPreference')),
      NotificationPreferenceUpdateRequest: coreRequestSchema({ emailNotify: { type: 'boolean' }, systemNotify: { type: 'boolean' }, approvalNotify: { type: 'boolean' }, aogAlert: { type: 'boolean' }, weeklyReport: { type: 'boolean' }, wechatNotify: { type: 'boolean' }, dingtalkNotify: { type: 'boolean' }, larkNotify: { type: 'boolean' }, smsNotify: { type: 'boolean' }, pushNotify: { type: 'boolean' } }),
      ChannelBinding: channelBinding,
      ChannelBindingListEnvelope: envelope({ type: 'array', items: schemaRef('ChannelBinding') }),
      ChannelBindingEnvelope: envelope(schemaRef('ChannelBinding')),
      ChannelBindingCreateRequest: coreRequestSchema({ channel: { type: 'string', minLength: 1 }, config: { type: 'object', additionalProperties: { type: 'string' } } }, ['channel']),
      ChannelBindingUpdateRequest: coreRequestSchema({ config: { type: 'object', additionalProperties: { type: 'string' } }, isActive: { type: 'boolean' } }),
      PushVapidEnvelope: envelope({ type: 'object', required: ['publicKey'], properties: { publicKey: { type: 'string' } } }),
      PushActionEnvelope: envelope({ type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } }),
      PushStatusEnvelope: envelope({ type: 'object', required: ['subscribed'], properties: { subscribed: { type: 'boolean' } } }),
      PushSubscribeRequest: coreRequestSchema({ endpoint: { type: 'string', format: 'uri' }, keys: { type: 'object', properties: { p256dh: { type: 'string' }, auth: { type: 'string' } }, additionalProperties: false } }, ['endpoint']),
      Action: envelope({ type: 'object', additionalProperties: true }),
      QuotationTransitionRequest: coreRequestSchema({ version: { type: 'integer', minimum: 1 }, reasonCode: { type: 'string' }, reason: { type: 'string' } }),
      QuotationApproveRequest: coreRequestSchema({ action: { type: 'string', enum: ['approve', 'reject'] }, comment: { type: 'string' }, version: { type: 'integer', minimum: 1 }, reasonCode: { type: 'string' }, reason: { type: 'string' } }, ['action']),
      QuotationSendRequest: coreRequestSchema({ subject: { type: 'string' }, message: { type: 'string' }, version: { type: 'integer', minimum: 1 }, reasonCode: { type: 'string' }, reason: { type: 'string' } }),
      QuotationWithdrawRequest: coreRequestSchema({ reason: { type: 'string', minLength: 1 }, sendWithdrawalNotice: { type: 'boolean', default: true }, version: { type: 'integer', minimum: 1 }, reasonCode: { type: 'string' } }, ['reason']),
      QuotationAcceptRequest: coreRequestSchema({ poNumber: { type: 'string' }, deliveryDate: date, templateId: id, confirmationNote: { type: 'string' }, version: { type: 'integer', minimum: 1 }, reasonCode: { type: 'string' }, reason: { type: 'string' } }),
      InventoryArrayEnvelope: envelope({ type: 'array', items: schemaRef('Inventory') }),
      InventoryReconciliationEnvelope: envelope({ type: 'object', required: ['status', 'checkedPartNumbers'], properties: { status: { type: 'string', enum: ['PASS', 'MISMATCH'] }, checkedPartNumbers: { type: 'integer' }, legacyTotal: { type: 'integer' }, comparedLegacyTotal: { type: 'integer' }, detailTotal: { type: 'integer' }, comparedDetailTotal: { type: 'integer' }, mismatches: { type: 'array', items: { type: 'object', additionalProperties: true } } } }),
      TrackingEnvelope: envelope({ type: ['object', 'null'], additionalProperties: true }),
      Rfq: rfq,
      RfqListEnvelope: envelope({ type: 'array', items: schemaRef('Rfq') }, { summary: { type: 'object', additionalProperties: true }, pagination: schemaRef('Pagination') }),
      RfqEnvelope: envelope(schemaRef('Rfq')),
      RfqCreateRequest: coreRequestSchema(rfqBase, ['customerId', 'partNumber', 'quantity']),
      RfqUpdateRequest: coreRequestSchema(rfqBase),
      RfqStatusUpdateRequest: coreRequestSchema({ status: { type: 'string' }, version: { type: 'integer', minimum: 1 }, reasonCode: { type: 'string' }, reason: { type: 'string' } }, ['status']),
      Quotation: quotation,
      QuotationListEnvelope: envelope({ type: 'array', items: schemaRef('Quotation') }, { summary: { type: 'object', additionalProperties: true }, pagination: schemaRef('Pagination') }),
      QuotationEnvelope: envelope(schemaRef('Quotation')),
      QuotationCreateRequest: coreRequestSchema(quotationBase, ['rfqId', 'customerId', 'partNumber', 'quantity', 'unitPrice', 'costPrice']),
      QuotationUpdateRequest: coreRequestSchema({ ...quotationBase, version: { type: 'integer', minimum: 1 } }),
      Order: order,
      OrderListEnvelope: envelope({ type: 'array', items: schemaRef('Order') }, { summary: { type: 'object', additionalProperties: true }, pagination: schemaRef('Pagination') }),
      OrderEnvelope: envelope(schemaRef('Order')),
      OrderCreateRequest: coreRequestSchema(orderBase, ['quotationId', 'customerId']),
      OrderUpdateRequest: coreRequestSchema({ ...orderBase, trackingNumber: { type: 'string' }, carrier: { type: 'string' } }),
      OrderStatusUpdateRequest: coreRequestSchema({ status: { type: 'string' }, version: { type: 'integer', minimum: 1 }, reasonCode: { type: 'string' }, reason: { type: 'string' } }, ['status']),
      Inventory: inventory,
      InventoryListEnvelope: envelope({ type: 'array', items: schemaRef('Inventory') }, { summary: { type: 'object', additionalProperties: true }, pagination: schemaRef('Pagination') }),
      InventoryEnvelope: envelope(schemaRef('Inventory')),
      InventoryCreateRequest: coreRequestSchema(inventoryBase, ['partNumber', 'description', 'location']),
      InventoryUpdateRequest: coreRequestSchema(inventoryBase),
      Customer: customer,
      CustomerListEnvelope: envelope({ type: 'array', items: schemaRef('Customer') }, { summary: { type: 'object', additionalProperties: true }, pagination: schemaRef('Pagination') }),
      CustomerEnvelope: envelope(schemaRef('Customer')),
      CustomerCreateRequest: coreRequestSchema(customerBase, ['name', 'contactName', 'email']),
      CustomerUpdateRequest: coreRequestSchema(customerBase),
      Supplier: supplier,
      SupplierListEnvelope: envelope({ type: 'array', items: schemaRef('Supplier') }, { summary: { type: 'object', additionalProperties: true }, pagination: schemaRef('Pagination') }),
      SupplierEnvelope: envelope(schemaRef('Supplier')),
      SupplierCreateRequest: coreRequestSchema(supplierBase, ['name', 'contactName']),
      SupplierUpdateRequest: coreRequestSchema(supplierBase),
      SupplierFollowUpLog: supplierFollowUpLog,
      SupplierFollowUpLogListEnvelope: envelope({ type: 'array', items: schemaRef('SupplierFollowUpLog') }),
      SupplierFollowUpLogBatchCreateRequest: coreRequestSchema({
        logs: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['supplierId', 'taskId', 'actionType', 'outcome'],
            properties: {
              supplierId: id,
              taskId: id,
              rfqId: id,
              rfqNumber: { type: 'string' },
              actionType: { type: 'string', enum: ['recorded_contact_follow_up', 'portal_follow_up', 'wechat_follow_up', 'whatsapp_follow_up', 'phone_follow_up', 'contact_missing'] },
              outcome: { type: 'string', enum: ['contacted_waiting_quote', 'quote_promised', 'follow_up_sent', 'portal_message_sent', 'contact_invalid'] },
              notes: { type: 'string' },
              preferredChannel: { type: 'string', enum: ['email', 'phone', 'manual'] },
            },
            additionalProperties: false,
          },
        },
      }, ['logs']),
      SupplierQuote: supplierQuote,
      SupplierQuoteEnvelope: envelope(schemaRef('SupplierQuote')),
      SupplierQuoteListEnvelope: envelope({ type: 'array', items: schemaRef('SupplierQuote') }, { pagination: schemaRef('Pagination') }),
      SupplierQuoteDetail: coreResourceSchema({
        ...supplierQuote.properties,
        rfq: { oneOf: [schemaRef('Rfq'), { type: 'null' }] },
        inquiry: { type: ['object', 'null'], additionalProperties: true },
      }, supplierQuote.required),
      SupplierQuoteDetailEnvelope: envelope(schemaRef('SupplierQuoteDetail')),
      SupplierQuoteDelete: coreResourceSchema({ message: { type: 'string' } }, ['message']),
      SupplierQuoteDeleteEnvelope: envelope(schemaRef('SupplierQuoteDelete')),
      SupplierQuoteWinner: coreResourceSchema({ message: { type: 'string' }, data: schemaRef('SupplierQuote') }, ['message', 'data']),
      SupplierQuoteWinnerEnvelope: envelope(schemaRef('SupplierQuoteWinner')),
      SupplierQuoteComparison: supplierQuoteComparison,
      SupplierQuoteComparisonEnvelope: envelope(schemaRef('SupplierQuoteComparison')),
      SupplierQuoteCreateRequest: coreRequestSchema({
        rfqId: id,
        inquiryId: id,
        supplierId: id,
        partNumber: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
        unitPrice: { type: 'number', minimum: 0 },
        leadTimeDays: { type: 'integer', minimum: 0 },
        validUntil: { type: 'string', format: 'date-time' },
        notes: { type: 'string' },
      }, ['supplierId', 'partNumber', 'quantity', 'unitPrice', 'leadTimeDays']),
      SupplierQuoteUpdateRequest: coreRequestSchema({
        unitPrice: { type: 'number', minimum: 0 },
        leadTimeDays: { type: 'integer', minimum: 0 },
        validUntil: { type: 'string', format: 'date-time' },
        notes: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'expired'] },
        isWinner: { type: 'boolean' },
      }),
      SupplierQuoteCompareRequest: {
        oneOf: [
          coreRequestSchema({ rfqId: id }, ['rfqId']),
          coreRequestSchema({ inquiryId: id }, ['inquiryId']),
        ],
      },
      AuditLog: auditLog,
      AuditLogEnvelope: envelope(schemaRef('AuditLog')),
      AuditLogListEnvelope: envelope({ type: 'array', items: schemaRef('AuditLog') }, { pagination: schemaRef('Pagination') }),
      AuditLogStats: auditLogStats,
      AuditLogStatsEnvelope: envelope(schemaRef('AuditLogStats')),
      AuditLogCreateRequest: coreRequestSchema({
        action: { type: 'string', minLength: 1 },
        resourceType: { type: 'string', minLength: 1 },
        resourceId: id,
        resourceName: { type: 'string' },
        changes: { type: 'object', additionalProperties: true },
        details: { type: 'string' },
        status: { type: 'string', enum: ['SUCCESS', 'FAILURE'] },
        errorMessage: { type: 'string' },
      }, ['action', 'resourceType']),
      ApiKey: apiKey,
      ApiKeyEnvelope: envelope(schemaRef('ApiKey')),
      ApiKeyListEnvelope: envelope({ type: 'array', items: schemaRef('ApiKey') }),
      ApiKeyCreate: apiKeyCreate,
      ApiKeyCreateEnvelope: envelope(schemaRef('ApiKeyCreate')),
      ApiKeyDelete: apiKeyDelete,
      ApiKeyDeleteEnvelope: envelope(schemaRef('ApiKeyDelete')),
      ApiKeyCreateRequest: coreRequestSchema({
        name: { type: 'string', minLength: 1 },
        scopes: { type: 'array', items: { type: 'string', minLength: 1 }, default: ['read'] },
        rateLimit: { type: 'integer', minimum: 1, default: 1000 },
        expiresAt: { type: 'string', format: 'date-time' },
      }, ['name']),
      ApiKeyUpdateRequest: coreRequestSchema({
        name: { type: 'string', minLength: 1 },
        scopes: { type: 'array', items: { type: 'string', minLength: 1 } },
        rateLimit: { type: 'integer', minimum: 1 },
        isActive: { type: 'boolean' },
        expiresAt: { type: 'string', format: 'date-time' },
      }),
      FeatureStatus: featureStatus,
      FeatureListEnvelope: envelope({ type: 'array', items: schemaRef('FeatureStatus') }),
      Ipc: ipc,
      IpcEnvelope: envelope(schemaRef('Ipc')),
      IpcListEnvelope: envelope({ type: 'array', items: schemaRef('Ipc') }),
      IpcCompatibility: ipcCompatibility,
      IpcCompatibilityEnvelope: envelope(schemaRef('IpcCompatibility')),
      PriceAvailability: priceAvailability,
      HistoricalPriceStats: historicalPriceStats,
      PriceRecommendation: priceRecommendation,
      PriceRecommendationEnvelope: envelope(schemaRef('PriceRecommendation')),
      PriceRecommendationListEnvelope: envelope({ type: 'array', items: schemaRef('PriceRecommendation') }),
      PriceRecommendationBatchRequest: priceRecommendationBatchRequest,
      PriceHistory: priceHistory,
      PriceHistoryEnvelope: envelope(schemaRef('PriceHistory')),
      PriceDashboard: priceDashboard,
      PriceDashboardEnvelope: envelope(schemaRef('PriceDashboard')),
      PricingBiSummary: pricingBiSummary,
      PricingBiSummaryEnvelope: envelope(schemaRef('PricingBiSummary')),
      PricingBiCollection: pricingBiCollection,
      PricingBiCollectionEnvelope: envelope(schemaRef('PricingBiCollection')),
      ConsumptionTrend: consumptionTrend,
      ConsumptionTrendListEnvelope: envelope({ type: 'array', items: schemaRef('ConsumptionTrend') }),
      SafetyStock: safetyStock,
      SafetyStockListEnvelope: envelope({ type: 'array', items: schemaRef('SafetyStock') }),
      InventoryHealthSummary: inventoryHealthSummary,
      InventoryHealthSummaryEnvelope: envelope(schemaRef('InventoryHealthSummary')),
      SeasonalForecast: seasonalForecast,
      SeasonalForecastEnvelope: envelope(schemaRef('SeasonalForecast')),
      Consignment: consignment,
      ConsignmentEnvelope: envelope(schemaRef('Consignment')),
      ConsignmentListEnvelope: listEnvelope('Consignment'),
      ConsignmentCreateRequest: coreRequestSchema({
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        supplierId: id,
        customerId: id,
        supplierName: { type: 'string', minLength: 1 },
        customerName: { type: 'string' },
        partNumber: { type: 'string', minLength: 1 },
        partDescription: { type: 'string' },
        quantity: { type: 'integer', minimum: 0 },
        unitCost: { type: 'number', minimum: 0 },
        currency: { type: 'string', default: 'USD' },
        conditionCode: { type: 'string' },
        agreementDate: dateTime,
        startDate: dateTime,
        endDate: dateTime,
        minStockLevel: { type: 'integer', minimum: 0 },
        reorderPoint: { type: 'integer', minimum: 0 },
        reorderQuantity: { type: 'integer', minimum: 0 },
        settlementTerms: { type: 'string', enum: ['MONTHLY', 'WEEKLY', 'PER_CONSUMPTION', 'QUARTERLY'] },
        paymentTerms: { type: 'string' },
        commissionRate: { type: 'number', minimum: 0 },
        inventoryId: id,
        orderIds: { type: 'string' },
      }, ['title', 'supplierId', 'supplierName', 'partNumber', 'endDate']),
      ConsignmentUpdateRequest: coreRequestSchema({
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'EXPIRED', 'TERMINATED', 'SETTLING'] },
        customerId: id,
        customerName: { type: 'string' },
        quantity: { type: 'integer', minimum: 0 },
        unitCost: { type: 'number', minimum: 0 },
        currency: { type: 'string' },
        conditionCode: { type: 'string' },
        startDate: dateTime,
        endDate: dateTime,
        minStockLevel: { type: 'integer', minimum: 0 },
        reorderPoint: { type: 'integer', minimum: 0 },
        reorderQuantity: { type: 'integer', minimum: 0 },
        settlementTerms: { type: 'string', enum: ['MONTHLY', 'WEEKLY', 'PER_CONSUMPTION', 'QUARTERLY'] },
        paymentTerms: { type: 'string' },
        commissionRate: { type: 'number', minimum: 0 },
        inventoryId: id,
        orderIds: { type: 'string' },
      }),
      ConsignmentConsumeRequest: coreRequestSchema({ quantity: { type: 'integer', minimum: 1 } }, ['quantity']),
      ConsignmentAlertsEnvelope: envelope({
        type: 'object',
        required: ['expiring', 'lowStock', 'totalAlerts'],
        properties: {
          expiring: { type: 'array', items: schemaRef('Consignment') },
          lowStock: { type: 'array', items: schemaRef('Consignment') },
          totalAlerts: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      }),
      FmvStage: fmvStage,
      Fmv: fmv,
      FmvEnvelope: envelope(schemaRef('Fmv')),
      FmvHistory: fmvHistory,
      FmvHistoryEnvelope: envelope(schemaRef('FmvHistory')),
      FmvBatchRequest: coreRequestSchema({
        items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['partNumber'], properties: { partNumber: { type: 'string', minLength: 1 }, conditionCode: { type: 'string' }, manufacturer: { type: 'string' }, ataChapter: { type: 'string' } }, additionalProperties: false } },
      }, ['items']),
      FmvBatchResult: envelope({
        type: 'object',
        required: ['results', 'total', 'successful'],
        properties: {
          results: { type: 'array', items: { oneOf: [
            { type: 'object', required: ['partNumber', 'success', 'data'], properties: { partNumber: { type: 'string' }, success: { const: true }, data: fmv }, additionalProperties: false },
            { type: 'object', required: ['partNumber', 'success', 'error'], properties: { partNumber: { type: 'string' }, success: { const: false }, error: { type: 'string' } }, additionalProperties: false },
          ] } },
          total: { type: 'integer', minimum: 0 },
          successful: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      }),
      Exchange: exchange,
      ExchangeListEnvelope: envelope({ type: 'array', items: schemaRef('Exchange') }),
      VmiAgreement: vmiAgreement,
      VmiAgreementListEnvelope: envelope({ type: 'array', items: schemaRef('VmiAgreement') }),
      RestockSuggestion: restockSuggestion,
      RestockSuggestionListEnvelope: envelope({ type: 'array', items: schemaRef('RestockSuggestion') }),
      ExchangeVmiStats: exchangeVmiStats,
      ExchangeVmiStatsEnvelope: envelope(schemaRef('ExchangeVmiStats')),
      WorkflowAction: workflowAction,
      WorkflowStep: workflowStep,
      WorkflowDefinition: workflowDefinition,
      WorkflowDefinitionEnvelope: envelope(schemaRef('WorkflowDefinition')),
      WorkflowDefinitionListEnvelope: envelope({ type: 'array', items: schemaRef('WorkflowDefinition') }),
      WorkflowInstanceStep: workflowInstanceStep,
      WorkflowInstance: workflowInstance,
      WorkflowInstanceEnvelope: envelope(schemaRef('WorkflowInstance')),
      WorkflowInstanceListEnvelope: envelope({ type: 'array', items: schemaRef('WorkflowInstance') }, { pagination: schemaRef('Pagination') }),
      WorkflowPendingListEnvelope: envelope({ type: 'array', items: schemaRef('WorkflowInstanceStep') }),
      WorkflowActionResult: coreResourceSchema({ message: { type: 'string' } }, ['message']),
      WorkflowActionResultEnvelope: envelope(schemaRef('WorkflowActionResult')),
      WorkflowStepRequest: workflowStepRequest,
      WorkflowDefinitionCreateRequest: coreRequestSchema({
        name: { type: 'string', minLength: 1 },
        code: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        entityType: { type: 'string', minLength: 1 },
        isActive: { type: 'boolean', default: true },
        isDefault: { type: 'boolean', default: false },
        steps: { type: 'array', items: workflowStepRequest, default: [] },
      }, ['name', 'code', 'entityType']),
      WorkflowDefinitionUpdateRequest: coreRequestSchema({
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        entityType: { type: 'string' },
        isActive: { type: 'boolean' },
        isDefault: { type: 'boolean' },
        steps: { type: 'array', items: workflowStepRequest },
      }),
      WorkflowInstanceCreateRequest: coreRequestSchema({
        definitionId: id,
        entityType: { type: 'string', minLength: 1 },
        entityId: id,
        context: { type: 'object', additionalProperties: true },
      }, ['definitionId', 'entityType', 'entityId']),
      WorkflowDecisionRequest: coreRequestSchema({
        comment: { type: 'string' },
        payload: { type: 'object', additionalProperties: true },
      }),
      WorkflowTransferRequest: coreRequestSchema({
        targetUserId: id,
        targetRole: { type: 'string' },
        comment: { type: 'string' },
      }),
      WorkflowCancelRequest: coreRequestSchema({ reason: { type: 'string' } }),
      IntegrityMetadata: integrityMetadata,
      BlockchainRecord: blockchainRecord,
      BlockchainRecordEnvelope: envelope(schemaRef('BlockchainRecord')),
      BlockchainCertificateVerification: blockchainCertificateVerification,
      BlockchainCertificateVerificationEnvelope: envelope(schemaRef('BlockchainCertificateVerification')),
      BlockchainChainVerification: blockchainChainVerification,
      BlockchainChainVerificationEnvelope: envelope(schemaRef('BlockchainChainVerification')),
      BlockchainStats: blockchainStats,
      BlockchainStatsEnvelope: envelope(schemaRef('BlockchainStats')),
      BlockchainRecordList: blockchainRecordList,
      BlockchainRecordListEnvelope: envelope(schemaRef('BlockchainRecordList')),
      BlockchainHash: blockchainHash,
      BlockchainHashEnvelope: envelope(schemaRef('BlockchainHash')),
      AgentRuntimeStep: agentRuntimeStep,
      AgentRuntimeConfirmationOption: agentRuntimeConfirmationOption,
      AgentRuntimeConfirmation: agentRuntimeConfirmation,
      AgentRuntimeTask: agentRuntimeTask,
      AgentRuntimeTaskEnvelope: envelope(schemaRef('AgentRuntimeTask')),
      AgentRuntimeTaskListEnvelope: envelope({ type: 'array', items: schemaRef('AgentRuntimeTask') }),
      AgentRuntimeDashboard: agentRuntimeDashboard,
      AgentRuntimeDashboardEnvelope: envelope(schemaRef('AgentRuntimeDashboard')),
      Agent: agent,
      AgentEnvelope: envelope(schemaRef('Agent')),
      AgentListEnvelope: envelope({ type: 'array', items: schemaRef('Agent') }),
      AgentLog: agentLog,
      AgentLogListEnvelope: envelope({ type: 'array', items: schemaRef('AgentLog') }),
      AgentAction: coreResourceSchema({ message: { type: 'string' } }, ['message']),
      AgentActionEnvelope: envelope(schemaRef('AgentAction')),
      AgentRunResult: coreResourceSchema({ output: { type: 'string' }, duration: { type: 'string' }, status: { type: 'string', enum: ['SUCCESS', 'ERROR'] } }, ['output', 'duration', 'status']),
      AgentRunResultEnvelope: envelope(schemaRef('AgentRunResult')),
      AiModel: aiModel,
      AiModelEnvelope: envelope(schemaRef('AiModel')),
      AiModelListEnvelope: envelope({ type: 'array', items: schemaRef('AiModel') }),
      AiModelTest: coreResourceSchema({ status: { type: 'string', enum: ['ok'] }, message: { type: 'string' }, latency: { type: 'integer', minimum: 0 }, response: { type: 'string' } }, ['status', 'message', 'latency', 'response']),
      AiModelTestEnvelope: envelope(schemaRef('AiModelTest')),
      ModelAction: coreResourceSchema({ message: { type: 'string' } }, ['message']),
      ModelActionEnvelope: envelope(schemaRef('ModelAction')),
      AiParsedEmail: aiParsedEmail,
      AiParsedEmailEnvelope: envelope(schemaRef('AiParsedEmail')),
      AiQuoteAnalysis: aiQuoteAnalysis,
      AiQuoteAnalysisEnvelope: envelope(schemaRef('AiQuoteAnalysis')),
      AiGeneratedEmail: aiGeneratedEmail,
      AiGeneratedEmailEnvelope: envelope(schemaRef('AiGeneratedEmail')),
      AiCompletion: aiCompletion,
      AiCompletionEnvelope: envelope(schemaRef('AiCompletion')),
      AgentRuntimeTaskSyncRequest: coreRequestSchema(agentRuntimeTask.properties, agentRuntimeTask.required),
      AgentCreateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 }, description: { type: 'string' }, isActive: { type: 'boolean' }, config: { type: 'object', additionalProperties: true }, prompts: { type: 'array', items: {} } }, ['name', 'type']),
      AgentUpdateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 }, description: { type: 'string' }, isActive: { type: 'boolean' }, config: { type: 'object', additionalProperties: true }, prompts: { type: 'array', items: {} } }),
      AgentRunRequest: coreRequestSchema({ task: { type: 'string' }, input: { type: 'object', additionalProperties: true } }),
      AiModelCreateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, provider: { type: 'string', enum: ['openai', 'anthropic', 'azure', 'ollama', 'deepseek', 'custom'] }, modelId: { type: 'string', minLength: 1 }, apiKey: { type: 'string', writeOnly: true }, baseUrl: { type: 'string', format: 'uri' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, config: { type: 'object', additionalProperties: true }, capabilities: { type: 'array', items: { type: 'string' } } }, ['name', 'provider', 'modelId']),
      AiModelUpdateRequest: coreRequestSchema({ name: { type: 'string', minLength: 1 }, provider: { type: 'string', enum: ['openai', 'anthropic', 'azure', 'ollama', 'deepseek', 'custom'] }, modelId: { type: 'string', minLength: 1 }, apiKey: { type: 'string', writeOnly: true }, baseUrl: { type: 'string', format: 'uri' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, config: { type: 'object', additionalProperties: true }, capabilities: { type: 'array', items: { type: 'string' } } }),
      AiParseEmailRequest: coreRequestSchema({ subject: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1 } }, ['subject', 'body']),
      AiAnalyzeQuotesRequest: coreRequestSchema({ rfqDetails: { type: 'string', minLength: 1 }, supplierQuotes: { type: 'string', minLength: 1 } }, ['rfqDetails', 'supplierQuotes']),
      AiGenerateEmailRequest: coreRequestSchema({ customerName: { type: 'string', minLength: 1 }, partNumber: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1, default: 1 }, unitPrice: { type: 'number', minimum: 0 }, totalPrice: { type: 'number', minimum: 0 }, incoterm: { type: 'string' }, incotermLocation: { type: 'string' }, leadTimeDays: { type: 'integer', minimum: 0 }, validityDays: { type: 'integer', minimum: 1, default: 30 } }, ['customerName', 'partNumber', 'unitPrice', 'totalPrice']),
      AiChatRequest: coreRequestSchema({ message: { type: 'string', minLength: 1 }, systemPrompt: { type: 'string' }, temperature: { type: 'number', minimum: 0, maximum: 2 }, maxTokens: { type: 'integer', minimum: 1 } }, ['message']),
      AuctionBid: auctionBid,
      Auction: auction,
      AuctionEnvelope: envelope(schemaRef('Auction')),
      AuctionListEnvelope: envelope({ type: 'array', items: schemaRef('Auction') }, { pagination: schemaRef('Pagination') }),
      AuctionDetail: auctionDetail,
      AuctionDetailEnvelope: envelope(schemaRef('AuctionDetail')),
      AuctionAction: auctionAction,
      AuctionActionEnvelope: envelope(schemaRef('AuctionAction')),
      AuctionBidListEnvelope: envelope({ type: 'array', items: schemaRef('AuctionBid') }),
      AuctionBidResult: auctionBidResult,
      AuctionBidResultEnvelope: envelope(schemaRef('AuctionBidResult')),
      AuctionCreateRequest: coreRequestSchema({
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        type: { type: 'string', enum: ['SALES', 'REVERSE', 'SEALED'], default: 'SALES' },
        partNumber: { type: 'string', minLength: 1 },
        partDescription: { type: 'string' },
        quantity: { type: 'integer', minimum: 1, default: 1 },
        conditionCode: { type: 'string' },
        certificateType: { type: 'string' },
        startingPrice: { type: 'number', minimum: 0 },
        reservePrice: { type: 'number', minimum: 0 },
        buyNowPrice: { type: 'number', minimum: 0 },
        currency: { type: 'string', default: 'USD' },
        startAt: dateTime,
        endAt: dateTime,
        autoExtend: { type: 'boolean', default: true },
        extendMinutes: { type: 'integer', minimum: 0, default: 5 },
        sellerId: id,
        buyerId: id,
        invitedSupplierIds: { type: 'array', items: id },
        inventoryId: id,
        rfqId: id,
      }, ['title', 'partNumber', 'startAt', 'endAt']),
      AuctionUpdateRequest: coreRequestSchema({
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        type: { type: 'string', enum: ['SALES', 'REVERSE', 'SEALED'] },
        partNumber: { type: 'string', minLength: 1 },
        partDescription: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
        conditionCode: { type: 'string' },
        certificateType: { type: 'string' },
        startingPrice: { type: 'number', minimum: 0 },
        reservePrice: { type: 'number', minimum: 0 },
        buyNowPrice: { type: 'number', minimum: 0 },
        currency: { type: 'string' },
        startAt: dateTime,
        endAt: dateTime,
        autoExtend: { type: 'boolean' },
        extendMinutes: { type: 'integer', minimum: 0 },
        sellerId: id,
        buyerId: id,
        invitedSupplierIds: { type: 'array', items: id },
        inventoryId: id,
        rfqId: id,
      }),
      AuctionBidCreateRequest: coreRequestSchema({
        amount: { type: 'number', minimum: 0 },
        quantity: { type: 'integer', minimum: 1, default: 1 },
        isAutoBid: { type: 'boolean', default: false },
        maxAutoBid: { type: 'number', minimum: 0 },
        notes: { type: 'string' },
      }, ['amount']),
      StatusHistory: envelope({ type: 'array', items: { type: 'object', additionalProperties: true } }),
    },
    responses: {
      Rfq: { description: 'RFQ response', content: { 'application/json': { schema: schemaRef('RfqEnvelope') } } },
      RfqList: { description: 'Paginated RFQ response', content: { 'application/json': { schema: schemaRef('RfqListEnvelope') } } },
      Quotation: { description: 'Quotation response', content: { 'application/json': { schema: schemaRef('QuotationEnvelope') } } },
      QuotationList: { description: 'Paginated quotation response', content: { 'application/json': { schema: schemaRef('QuotationListEnvelope') } } },
      Order: { description: 'Order response', content: { 'application/json': { schema: schemaRef('OrderEnvelope') } } },
      OrderList: { description: 'Paginated order response', content: { 'application/json': { schema: schemaRef('OrderListEnvelope') } } },
      Inventory: { description: 'Inventory response', content: { 'application/json': { schema: schemaRef('InventoryEnvelope') } } },
      InventoryList: { description: 'Paginated inventory response', content: { 'application/json': { schema: schemaRef('InventoryListEnvelope') } } },
      Customer: { description: 'Customer response', content: { 'application/json': { schema: schemaRef('CustomerEnvelope') } } },
      CustomerList: { description: 'Paginated customer response', content: { 'application/json': { schema: schemaRef('CustomerListEnvelope') } } },
      Supplier: { description: 'Supplier response', content: { 'application/json': { schema: schemaRef('SupplierEnvelope') } } },
      SupplierList: { description: 'Paginated supplier response', content: { 'application/json': { schema: schemaRef('SupplierListEnvelope') } } },
      StatusHistory: { description: 'Status history response', content: { 'application/json': { schema: schemaRef('StatusHistory') } } },
      User: { description: 'Authenticated user response', content: { 'application/json': { schema: schemaRef('UserEnvelope') } } },
      Capabilities: { description: 'Capability snapshot response', content: { 'application/json': { schema: schemaRef('CapabilitiesEnvelope') } } },
      Sessions: { description: 'Managed sessions response', content: { 'application/json': { schema: schemaRef('SessionsEnvelope') } } },
      SessionRevokeAll: { description: 'All sessions revocation response', content: { 'application/json': { schema: schemaRef('SessionRevokeAllEnvelope') } } },
      SessionRevoke: { description: 'Session revocation response', content: { 'application/json': { schema: schemaRef('SessionRevokeEnvelope') } } },
      SecurityEvents: { description: 'Security events response', content: { 'application/json': { schema: schemaRef('SecurityEventsEnvelope') } } },
      SecurityEvent: { description: 'Security event response', content: { 'application/json': { schema: schemaRef('SecurityEventEnvelope') } } },
      ActivationInfo: { description: 'Activation token information', content: { 'application/json': { schema: schemaRef('ActivationInfoEnvelope') } } },
      ResetInfo: { description: 'Password reset token information', content: { 'application/json': { schema: schemaRef('ResetInfoEnvelope') } } },
      Message: { description: 'Message response', content: { 'application/json': { schema: schemaRef('MessageEnvelope') } } },
      Action: { description: 'Quotation workflow action response', content: { 'application/json': { schema: schemaRef('Action') } } },
      InventoryArray: { description: 'Inventory records response', content: { 'application/json': { schema: schemaRef('InventoryArrayEnvelope') } } },
      InventoryReconciliation: { description: 'Inventory reconciliation response', content: { 'application/json': { schema: schemaRef('InventoryReconciliationEnvelope') } } },
      Tracking: { description: 'Order tracking response', content: { 'application/json': { schema: schemaRef('TrackingEnvelope') } } },
      Health: resourceResponse('Public health response', 'HealthEnvelope'),
      Metrics: resourceResponse('Protected aggregate metrics response', 'MetricsEnvelope'),
      FileDownload: {
        description: 'Authorized object download',
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      DocumentTemplate: resourceResponse('Document template response', 'DocumentTemplate'),
      DocumentTemplateList: resourceResponse('Document template list response', 'DocumentTemplateListEnvelope'),
      GeneratedDocument: resourceResponse('Generated document response', 'GeneratedDocument'),
      GeneratedDocumentList: resourceResponse('Generated document list response', 'GeneratedDocumentListEnvelope'),
      CertificateTemplate: resourceResponse('Certificate template response', 'CertificateTemplate'),
      CertificateTemplateList: resourceResponse('Certificate template list response', 'CertificateTemplateListEnvelope'),
      Certificate: resourceResponse('Certificate response', 'Certificate'),
      CertificateList: resourceResponse('Certificate list response', 'CertificateListEnvelope'),
      CertificateVerification: resourceResponse('Certificate verification response', 'CertificateVerificationEnvelope'),
      CertificateAction: resourceResponse('Certificate action response', 'CertificateActionEnvelope'),
      CertificateDownload: resourceResponse('Certificate download response', 'CertificateDownloadEnvelope'),
      CertificateExpiring: resourceResponse('Expiring certificates response', 'CertificateExpiringEnvelope'),
      WebhookEvents: resourceResponse('Supported webhook events response', 'WebhookEventsEnvelope'),
      WebhookEndpoint: resourceResponse('Webhook endpoint response', 'WebhookEndpoint'),
      WebhookEndpointList: resourceResponse('Webhook endpoint list response', 'WebhookEndpointListEnvelope'),
      WebhookSubscriptionList: resourceResponse('Webhook subscription list response', 'WebhookSubscriptionListEnvelope'),
      WebhookDelivery: resourceResponse('Webhook delivery response', 'WebhookDelivery'),
      WebhookDeliveryList: resourceResponse('Webhook delivery list response', 'WebhookDeliveryListEnvelope'),
      InboundEndpoint: resourceResponse('Inbound webhook endpoint response', 'InboundEndpoint'),
      InboundEndpointList: resourceResponse('Inbound webhook endpoint list response', 'InboundEndpointListEnvelope'),
      InboundDeliveryList: resourceResponse('Inbound webhook delivery list response', 'InboundDeliveryListEnvelope'),
      WebhookAuditList: resourceResponse('Webhook audit list response', 'WebhookAuditListEnvelope'),
      InboundAccepted: resourceResponse('Inbound webhook accepted response', 'InboundAcceptedEnvelope'),
      WebhookPhase2: resourceResponse('Phase 2 webhook operation response', 'WebhookPhase2Response'),
      OutboxEvent: resourceResponse('Outbox event response', 'OutboxEvent'),
      OutboxList: resourceResponse('Outbox list response', 'OutboxListEnvelope'),
      OutboxStats: resourceResponse('Outbox stats response', 'OutboxStatsEnvelope'),
      OutboxAction: resourceResponse('Outbox action response', 'OutboxActionEnvelope'),
      DashboardStats: resourceResponse('Dashboard statistics response', 'DashboardStatsEnvelope'),
      DashboardFunnel: resourceResponse('Dashboard funnel response', 'DashboardFunnelEnvelope'),
      DashboardActivities: resourceResponse('Dashboard activity response', 'DashboardActivitiesEnvelope'),
      NotificationList: resourceResponse('Notification list response', 'NotificationListEnvelope'),
      NotificationUnreadCount: resourceResponse('Notification unread count response', 'NotificationUnreadCountEnvelope'),
      NotificationAction: resourceResponse('Notification action response', 'NotificationActionEnvelope'),
      NotificationDispatch: resourceResponse('Notification dispatch response', 'NotificationDispatchEnvelope'),
      ManagedUser: resourceResponse('Managed user response', 'ManagedUserEnvelope'),
      ManagedUserList: resourceResponse('Managed user list response', 'ManagedUserListEnvelope'),
      ManagedUserOnboarding: resourceResponse('Managed user onboarding response', 'ManagedUserOnboardingEnvelope'),
      ManagedUserDelete: resourceResponse('Managed user deletion response', 'ManagedUserDeleteEnvelope'),
      SupplierFollowUpLogList: resourceResponse('Supplier follow-up log list response', 'SupplierFollowUpLogListEnvelope'),
      SupplierQuote: resourceResponse('Supplier quote response', 'SupplierQuoteEnvelope'),
      SupplierQuoteList: resourceResponse('Supplier quote list response', 'SupplierQuoteListEnvelope'),
      SupplierQuoteDetail: resourceResponse('Supplier quote detail response', 'SupplierQuoteDetailEnvelope'),
      SupplierQuoteDelete: resourceResponse('Supplier quote deletion response', 'SupplierQuoteDeleteEnvelope'),
      SupplierQuoteWinner: resourceResponse('Supplier quote winner response', 'SupplierQuoteWinnerEnvelope'),
      SupplierQuoteComparison: resourceResponse('Supplier quote comparison response', 'SupplierQuoteComparisonEnvelope'),
      AuditLog: resourceResponse('Audit log response', 'AuditLogEnvelope'),
      AuditLogList: resourceResponse('Audit log list response', 'AuditLogListEnvelope'),
      AuditLogStats: resourceResponse('Audit log statistics response', 'AuditLogStatsEnvelope'),
      ApiKey: resourceResponse('API key response without secret material', 'ApiKeyEnvelope'),
      ApiKeyList: resourceResponse('API key list response without secret material', 'ApiKeyListEnvelope'),
      ApiKeyCreate: resourceResponse('API key creation response; secret returned once', 'ApiKeyCreateEnvelope'),
      ApiKeyDelete: resourceResponse('API key revoke response', 'ApiKeyDeleteEnvelope'),
      FeatureList: resourceResponse('Product feature availability response', 'FeatureListEnvelope'),
      Ipc: resourceResponse('IPC reference response', 'IpcEnvelope'),
      IpcList: resourceResponse('IPC reference search response', 'IpcListEnvelope'),
      IpcCompatibility: resourceResponse('IPC compatibility response', 'IpcCompatibilityEnvelope'),
      PriceRecommendation: resourceResponse('Internal price recommendation response', 'PriceRecommendationEnvelope'),
      PriceRecommendationList: resourceResponse('Internal price recommendation list response', 'PriceRecommendationListEnvelope'),
      PriceHistory: resourceResponse('Internal price history response', 'PriceHistoryEnvelope'),
      PriceDashboard: resourceResponse('Internal price dashboard response', 'PriceDashboardEnvelope'),
      PricingBiSummary: resourceResponse('Pricing BI summary response', 'PricingBiSummaryEnvelope'),
      PricingBiCollection: resourceResponse('Pricing BI collection response', 'PricingBiCollectionEnvelope'),
      ConsumptionTrendList: resourceResponse('Inventory consumption trend response', 'ConsumptionTrendListEnvelope'),
      SafetyStockList: resourceResponse('Safety stock recommendation response', 'SafetyStockListEnvelope'),
      InventoryHealthSummary: resourceResponse('Inventory health summary response', 'InventoryHealthSummaryEnvelope'),
      SeasonalForecast: resourceResponse('Inventory seasonal forecast response', 'SeasonalForecastEnvelope'),
      Consignment: resourceResponse('Consignment response', 'ConsignmentEnvelope'),
      ConsignmentList: resourceResponse('Consignment list response', 'ConsignmentListEnvelope'),
      ConsignmentAlerts: resourceResponse('Consignment alerts response', 'ConsignmentAlertsEnvelope'),
      Fmv: resourceResponse('Fair market value response', 'FmvEnvelope'),
      FmvHistory: resourceResponse('Fair market value history response', 'FmvHistoryEnvelope'),
      FmvBatchResult: resourceResponse('Fair market value batch response', 'FmvBatchResult'),
      ExchangeList: resourceResponse('Exchange order projection response', 'ExchangeListEnvelope'),
      VmiAgreementList: resourceResponse('VMI agreement projection response', 'VmiAgreementListEnvelope'),
      RestockSuggestionList: resourceResponse('VMI restock suggestion response', 'RestockSuggestionListEnvelope'),
      ExchangeVmiStats: resourceResponse('Exchange and VMI statistics response', 'ExchangeVmiStatsEnvelope'),
      WorkflowDefinition: resourceResponse('Workflow definition response', 'WorkflowDefinitionEnvelope'),
      WorkflowDefinitionList: resourceResponse('Workflow definition list response', 'WorkflowDefinitionListEnvelope'),
      WorkflowInstance: resourceResponse('Workflow instance response', 'WorkflowInstanceEnvelope'),
      WorkflowInstanceList: resourceResponse('Workflow instance list response', 'WorkflowInstanceListEnvelope'),
      WorkflowPendingList: resourceResponse('Pending workflow steps response', 'WorkflowPendingListEnvelope'),
      WorkflowActionResult: resourceResponse('Workflow action result response', 'WorkflowActionResultEnvelope'),
      BlockchainRecord: resourceResponse('Blockchain integrity record response', 'BlockchainRecordEnvelope'),
      BlockchainCertificateVerification: resourceResponse('Certificate integrity verification response', 'BlockchainCertificateVerificationEnvelope'),
      BlockchainChainVerification: resourceResponse('Integrity chain verification response', 'BlockchainChainVerificationEnvelope'),
      BlockchainStats: resourceResponse('Integrity chain statistics response', 'BlockchainStatsEnvelope'),
      BlockchainRecordList: resourceResponse('Integrity chain record list response', 'BlockchainRecordListEnvelope'),
      BlockchainHash: resourceResponse('Certificate content hash response', 'BlockchainHashEnvelope'),
      AgentRuntimeTask: resourceResponse('Agent runtime task response', 'AgentRuntimeTaskEnvelope'),
      AgentRuntimeTaskList: resourceResponse('Agent runtime task list response', 'AgentRuntimeTaskListEnvelope'),
      AgentRuntimeDashboard: resourceResponse('Agent runtime dashboard response', 'AgentRuntimeDashboardEnvelope'),
      Agent: resourceResponse('Agent response', 'AgentEnvelope'),
      AgentList: resourceResponse('Agent list response', 'AgentListEnvelope'),
      AgentLogList: resourceResponse('Agent log list response', 'AgentLogListEnvelope'),
      AgentAction: resourceResponse('Agent action response', 'AgentActionEnvelope'),
      AgentRunResult: resourceResponse('Agent run response', 'AgentRunResultEnvelope'),
      AiModel: resourceResponse('AI model response without API key', 'AiModelEnvelope'),
      AiModelList: resourceResponse('AI model list response without API key', 'AiModelListEnvelope'),
      AiModelTest: resourceResponse('AI model connectivity test response', 'AiModelTestEnvelope'),
      ModelAction: resourceResponse('AI model action response', 'ModelActionEnvelope'),
      AiParsedEmail: resourceResponse('AI email parsing response', 'AiParsedEmailEnvelope'),
      AiQuoteAnalysis: resourceResponse('AI quote analysis response', 'AiQuoteAnalysisEnvelope'),
      AiGeneratedEmail: resourceResponse('AI generated email response', 'AiGeneratedEmailEnvelope'),
      AiCompletion: resourceResponse('AI chat completion response', 'AiCompletionEnvelope'),
      Auction: resourceResponse('Auction response', 'AuctionEnvelope'),
      AuctionList: resourceResponse('Auction list response', 'AuctionListEnvelope'),
      AuctionDetail: resourceResponse('Auction detail response', 'AuctionDetailEnvelope'),
      AuctionAction: resourceResponse('Auction action response', 'AuctionActionEnvelope'),
      AuctionBid: resourceResponse('Auction bid response', 'AuctionBidResultEnvelope'),
      AuctionBidList: resourceResponse('Auction bid list response', 'AuctionBidListEnvelope'),
      Email: resourceResponse('Email response', 'EmailEnvelope'),
      EmailList: resourceResponse('Email list response', 'EmailListEnvelope'),
      EmailAccount: resourceResponse('Email account response', 'EmailAccountEnvelope'),
      EmailAccountList: resourceResponse('Email account list response', 'EmailAccountListEnvelope'),
      AuthEmailDelivery: resourceResponse('Authentication email delivery response', 'AuthEmailDeliveryEnvelope'),
      EmailConnectionTest: resourceResponse('Email connection test response', 'EmailConnectionTestEnvelope'),
      EmailSync: resourceResponse('Email sync response', 'EmailSyncEnvelope'),
      ReportSummary: { description: 'Report summary response', content: { 'application/json': { schema: schemaRef('ReportSummary') } } },
      ReportSalesTrend: { description: 'Report sales trend response', content: { 'application/json': { schema: schemaRef('ReportSalesTrend') } } },
      ReportConversion: { description: 'Report conversion response', content: { 'application/json': { schema: schemaRef('ReportConversion') } } },
      ReportCustomerContribution: { description: 'Customer contribution response', content: { 'application/json': { schema: schemaRef('ReportCustomerContribution') } } },
      ReportInventoryTurnover: { description: 'Inventory turnover response', content: { 'application/json': { schema: schemaRef('ReportInventoryTurnover') } } },
      Upload: resourceResponse('Uploaded object response', 'UploadEnvelope'),
      UploadList: resourceResponse('Uploaded objects response', 'UploadListEnvelope'),
      InventoryItemListRaw: { description: 'Inventory item list response', content: { 'application/json': { schema: schemaRef('InventoryItemListRaw') } } },
      InventoryItemRaw: { description: 'Inventory item response', content: { 'application/json': { schema: schemaRef('InventoryItemRaw') } } },
      InventoryTransactionList: resourceResponse('Inventory transaction list response', 'InventoryTransactionListEnvelope'),
      InventoryTransactionAction: resourceResponse('Inventory transaction action response', 'InventoryTransactionActionEnvelope'),
      ShipmentTrackingList: resourceResponse('Shipment tracking list response', 'ShipmentTrackingListEnvelope'),
      ShipmentTracking: resourceResponse('Shipment tracking response', 'ShipmentTrackingEnvelope'),
      ShipmentCustomsRiskList: resourceResponse('Shipment customs risk response', 'ShipmentCustomsRiskListEnvelope'),
      ShipmentAlertList: resourceResponse('Shipment alert response', 'ShipmentAlertListEnvelope'),
      Inquiry: resourceResponse('Inquiry response', 'InquiryEnvelope'),
      InquiryList: resourceResponse('Inquiry list response', 'InquiryListEnvelope'),
      NotificationPreference: resourceResponse('Notification preference response', 'NotificationPreferenceEnvelope'),
      ChannelBinding: resourceResponse('Channel binding response', 'ChannelBindingEnvelope'),
      ChannelBindingList: resourceResponse('Channel binding list response', 'ChannelBindingListEnvelope'),
      PushVapid: resourceResponse('Push VAPID response', 'PushVapidEnvelope'),
      PushAction: resourceResponse('Push action response', 'PushActionEnvelope'),
      PushStatus: resourceResponse('Push status response', 'PushStatusEnvelope'),
    },
  };
}

export function buildScaffold() {
  const catalog = discoverRouteCatalog();
  const paths = {};
  for (const endpoint of catalog.operations) {
    const openApiPath = toOpenApiPath(endpoint.path);
    const method = endpoint.method.toLowerCase();
    const baseOperation = {
      operationId: operationId(endpoint.method, endpoint.path),
      tags: [tagForPath(endpoint.path)],
      summary: `${endpoint.method} ${endpoint.path}`,
      description: 'Initial route inventory contract. Replace generic schemas with the existing DTO and validation contract before marking this operation complete.',
      'x-aerolink-contract-status': 'inventory',
      'x-aerolink-owner': `P2-01/${tagForPath(endpoint.path)}`,
      'x-aerolink-deferred-reason': 'Route is catalogued and protected by drift checks; request/response DTO mapping is completed in the corresponding domain vertical slice.',
      'x-aerolink-source': {
        file: endpoint.routeFile === 'index' ? 'server/src/index.ts' : `server/src/routes/${endpoint.routeFile}.ts`,
        line: endpoint.sourceLine,
      },
      security: securityForPath(endpoint.path),
      parameters: parametersFor(endpoint, openApiPath),
      responses: responsesFor(endpoint.path),
    };
    const requestBody = requestBodyFor(endpoint.method, endpoint.path);
    if (requestBody) baseOperation.requestBody = requestBody;
    const operation = {
      ...baseOperation,
      ...(authOperationContract(endpoint, openApiPath) ?? {}),
      ...(systemOperationContract(endpoint) ?? {}),
      ...(versionedReadContract(endpoint, openApiPath) ?? {}),
      ...(coreOperationContract(endpoint, openApiPath) ?? {}),
      ...(integrationOperationContract(endpoint, openApiPath) ?? {}),
      ...(reportingOperationContract(endpoint, openApiPath) ?? {}),
      ...(supportingOperationContract(endpoint, openApiPath) ?? {}),
      ...(identityCommunicationOperationContract(endpoint, openApiPath) ?? {}),
      ...(emailSyncOperationContract(endpoint, openApiPath) ?? {}),
      ...(blockchainOperationContract(endpoint, openApiPath) ?? {}),
      ...(agentAndModelOperationContract(endpoint, openApiPath) ?? {}),
      ...(aiOperationContract(endpoint, openApiPath) ?? {}),
      ...(auctionOperationContract(endpoint, openApiPath) ?? {}),
      ...(supplierCommercialOperationContract(endpoint, openApiPath) ?? {}),
      ...(referenceAndAdministrationOperationContract(endpoint, openApiPath) ?? {}),
      ...(analyticsAndPricingOperationContract(endpoint, openApiPath) ?? {}),
      ...(valuationAndInventoryOperationContract(endpoint, openApiPath) ?? {}),
      ...(workflowOperationContract(endpoint, openApiPath) ?? {}),
    };
    if (operation['x-aerolink-contract-status'] === 'inventory') {
      Object.assign(operation, cataloguedOperationContract(endpoint, openApiPath));
    }
    if (!paths[openApiPath]) paths[openApiPath] = {};
    paths[openApiPath][method] = operation;
  }

  const core = coreComponents();

  return {
    openapi: '3.1.0',
    info: {
      title: 'AeroLink API',
      version: 'p2-01-baseline',
      description: '契约真相源。金额使用 Decimal 字符串，日期时间使用 RFC 3339；所有错误均使用既有错误信封。',
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [{ url: '/', description: 'Current host' }],
    tags: [...new Set(catalog.operations.map((endpoint) => tagForPath(endpoint.path)))].map((name) => ({
      name,
      description: `Routes mounted under ${name}`,
    })),
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      requestBodies: {
        Login: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } },
          },
        },
        JsonBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/JsonObject' },
            },
          },
        },
        MultipartUpload: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { type: 'object', additionalProperties: { type: 'string', format: 'binary' } },
            },
          },
        },
        ...core.requestBodies,
      },
      responses: {
        AuthLogin: {
          description: 'Authenticated; refresh token is rotated in an HttpOnly cookie.',
          headers: {
            'Set-Cookie': {
              description: 'HttpOnly refresh-token cookie; never exposed to JavaScript.',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthLoginEnvelope' } } },
        },
        AuthRefresh: {
          description: 'Access token refreshed; refresh token is rotated in an HttpOnly cookie.',
          headers: {
            'Set-Cookie': {
              description: 'HttpOnly refresh-token cookie; never exposed to JavaScript.',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthRefreshEnvelope' } } },
        },
        AuthLogout: {
          description: 'Session logout; refresh-token cookie is cleared.',
          headers: {
            'Set-Cookie': {
              description: 'Expired HttpOnly refresh-token cookie.',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } },
        },
        Success: {
          description: 'Successful response',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } },
        },
        Error: {
          description: 'Error envelope',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
        },
        CsvExport: {
          description: 'CSV export',
          content: { 'text/csv': { schema: { type: 'string' } } },
        },
        PdfDocument: {
          description: 'PDF document',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        ...core.responses,
      },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refreshToken' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        inboundWebhookSignature: { type: 'apiKey', in: 'header', name: 'X-Webhook-Signature' },
      },
      schemas: {
        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
          additionalProperties: false,
        },
        AuthLoginEnvelope: {
          type: 'object',
          required: ['success', 'data'],
          properties: {
            success: { const: true },
            data: {
              type: 'object',
              required: ['token', 'user'],
              properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/JsonObject' } },
              additionalProperties: true,
            },
          },
        },
        AuthRefreshEnvelope: {
          type: 'object',
          required: ['success', 'data'],
          properties: {
            success: { const: true },
            data: { type: 'object', required: ['accessToken'], properties: { accessToken: { type: 'string' } } },
          },
        },
        JsonObject: { type: 'object', additionalProperties: true },
        SuccessEnvelope: {
          type: 'object',
          required: ['success'],
          properties: {
            success: { const: true },
            data: {},
            pagination: { $ref: '#/components/schemas/Pagination' },
          },
          additionalProperties: true,
        },
        ErrorEnvelope: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { const: false },
            error: {
              type: 'object',
              required: ['message'],
              properties: {
                message: { type: 'string' },
                code: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: true,
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1 },
            total: { type: 'integer', minimum: 0 },
            totalPages: { type: 'integer', minimum: 0 },
            sort: { type: 'string' },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
          additionalProperties: true,
        },
        HealthEnvelope: {
          type: 'object',
          required: ['status', 'timestamp'],
          properties: { status: { const: 'ok' }, timestamp: { type: 'string', format: 'date-time' } },
          additionalProperties: false,
        },
        MetricsEnvelope: {
          type: 'object',
          required: ['success', 'data'],
          properties: {
            success: { const: true },
            data: {
              type: 'object',
              required: ['requests', 'errors', 'byStatus', 'latencyMs', 'database'],
              properties: {
                requests: { type: 'integer', minimum: 0 },
                errors: { type: 'integer', minimum: 0 },
                byStatus: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
                latencyMs: { type: 'object', additionalProperties: true },
                database: {
                  type: 'object',
                  required: ['queries', 'errors', 'latencyMs', 'slowQueries'],
                  properties: {
                    queries: { type: 'integer', minimum: 0 },
                    errors: { type: 'integer', minimum: 0 },
                    latencyMs: { type: 'object', additionalProperties: true },
                    slowQueries: { type: 'integer', minimum: 0 },
                  },
                  additionalProperties: false,
                },
                alerts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'key', 'severity', 'title', 'message', 'source', 'firstSeenAt', 'lastSeenAt', 'metadata'],
                    properties: {
                      id: { type: 'string' },
                      key: { type: 'string' },
                      severity: { type: 'string', enum: ['warning', 'critical'] },
                      title: { type: 'string' },
                      message: { type: 'string' },
                      source: { type: 'string' },
                      firstSeenAt: { type: 'string', format: 'date-time' },
                      lastSeenAt: { type: 'string', format: 'date-time' },
                      resolvedAt: { type: 'string', format: 'date-time' },
                      metadata: { type: 'object', additionalProperties: true },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        ...core.schemas,
      },
      'x-aerolink-route-catalog': {
        source: catalog.source,
        mountCount: catalog.mounts.length,
        operationCount: catalog.operations.length,
      },
    },
  };
}

if (process.argv.includes('--write')) {
  if (fs.existsSync(outputPath) && !process.argv.includes('--force')) {
    console.error(`${path.relative(repoRoot, outputPath)} already exists; use --force only to replace the scaffold.`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(buildScaffold(), null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${path.relative(repoRoot, outputPath)}\n`);
}
