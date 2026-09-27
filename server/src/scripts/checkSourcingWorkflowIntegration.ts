/**
 * Isolated SMTP -> IMAP -> AI draft -> human confirmation -> line comparison
 * acceptance check. This script never loads dotenv or the production entrypoint.
 * It requires an explicitly named loopback PostgreSQL database, an explicit
 * isolated-run confirmation, and the fixed loopback GreenMail ports.
 *
 * Rows created by a successful run are intentionally retained for the browser
 * acceptance that follows. The owning one-time database/container is removed
 * by the caller after all acceptance evidence has been collected.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import express from 'express';
import { createTransport } from 'nodemailer';
import type { AuthRequest } from '../middleware/auth.js';

const CONFIRMATION = 'isolated';
const DATABASE_NAME = 'aerolink_sourcing_workflow_test';
const DATABASE_HOST = '127.0.0.1';
const DATABASE_PORT = 55433;
const SMTP_HOST = '127.0.0.1';
const SMTP_PORT = 53025;
const IMAP_HOST = '127.0.0.1';
const IMAP_PORT = 53143;
const MAIL_PASSWORD = 'acceptance-only';
const BUYER_EMAIL = 'buyer@sourcing.test';
const MAILBOX_DOMAIN = 'sourcing.test';
const MODEL_SECRET = 'sourcing-workflow-local-fixture-only';
const MANUAL_FALLBACK_ONLY_ENV = 'SOURCING_WORKFLOW_MANUAL_FALLBACK_ONLY';
const MANAGER_ID = 'u001';
const SALES_USER_ID = 'test-sales';
const CUSTOMER_ID = 'c001';
const ACCEPTANCE_RFQ_NOTES = 'One-time SMTP/IMAP sourcing workflow integration acceptance.';
const SUPPLIER_FIXTURES = [
  { id: 's001', expectedSeedEmail: 'john@aviationparts.com', email: 'supplier1@sourcing.test', name: 'Aviation Parts Inc.' },
  { id: 's002', expectedSeedEmail: 'sarah@globalaero.com', email: 'supplier2@sourcing.test', name: 'Global Aero Supply' },
  { id: 's003', expectedSeedEmail: 'liwei@pacificcomp.com', email: 'supplier3@sourcing.test', name: 'Pacific Components' },
] as const;

type JsonRecord = Record<string, unknown>;
type RouteResponse = { status: number; body: JsonRecord };
type FixtureRequest = {
  method: string;
  url: string;
  host: string | undefined;
  authorization: string | undefined;
  model: string | undefined;
  messages: Array<{ role: string; content: string }>;
};
type LocalFixture = {
  baseUrl: string;
  requests: FixtureRequest[];
  failNextRequests: number;
  close: () => Promise<void>;
};
type LocalHttpServer = { baseUrl: string; close: () => Promise<void> };
type RfqLine = {
  id: string;
  lineNo: number;
  partNumber: string;
  quantity: number;
  uom: string;
  requiredDate: Date;
};
type SupplierOffer = {
  lineId: string;
  lineNo: number;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  leadTimeDays: number;
  evidenceText: string;
};
type SupplierRun = {
  supplierId: string;
  supplierEmail: string;
  inquiryId: string;
  outboundEmailId: string;
  outboxEventId: string;
  providerMessageId: string;
  offers: SupplierOffer[];
  inboundEmailId?: string;
  taskId?: string;
  draftId?: string;
  quoteIds?: string[];
};

type PartialRecovery = {
  stage: 'send-queued' | 'drafts-ready' | 'drafts-partially-patched' | 'drafts-patched';
  rfqId: string;
  inquiryId?: string;
  outboundEmailId?: string;
  outboxEventId?: string;
  emailAccountId: string;
  modelId: string;
};

const resultArtifact: JsonRecord = {
  ok: false,
  retained: true,
  rfqId: null,
  inquiryIds: [],
  emailIds: [],
  draftIds: [],
  supplierQuoteIds: [],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function databaseName(databaseUrl: string): string {
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

function assertIsolatedEnvironment() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required; refusing an implicit or dotenv database');

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('The sourcing workflow integration requires PostgreSQL');
  }
  if (url.hostname !== DATABASE_HOST) {
    throw new Error(`DATABASE_URL host must be ${DATABASE_HOST}`);
  }
  if (Number(url.port) !== DATABASE_PORT) {
    throw new Error(`DATABASE_URL port must be ${DATABASE_PORT}`);
  }
  if (databaseName(databaseUrl) !== DATABASE_NAME) {
    throw new Error(`DATABASE_URL database name must be exactly ${DATABASE_NAME}`);
  }
  if (process.env.SOURCING_WORKFLOW_INTEGRATION_CONFIRM !== CONFIRMATION) {
    throw new Error('Set SOURCING_WORKFLOW_INTEGRATION_CONFIRM=isolated to authorize this one-time database run');
  }
  if (process.env[MANUAL_FALLBACK_ONLY_ENV] && process.env[MANUAL_FALLBACK_ONLY_ENV] !== CONFIRMATION) {
    throw new Error(`${MANUAL_FALLBACK_ONLY_ENV} must be isolated when set`);
  }

  const configuredSmtpPort = process.env.SOURCING_WORKFLOW_SMTP_PORT;
  const configuredImapPort = process.env.SOURCING_WORKFLOW_IMAP_PORT;
  if (process.env.SOURCING_WORKFLOW_SMTP_HOST && process.env.SOURCING_WORKFLOW_SMTP_HOST !== SMTP_HOST) {
    throw new Error(`SOURCING_WORKFLOW_SMTP_HOST must be ${SMTP_HOST}`);
  }
  if (process.env.SOURCING_WORKFLOW_IMAP_HOST && process.env.SOURCING_WORKFLOW_IMAP_HOST !== IMAP_HOST) {
    throw new Error(`SOURCING_WORKFLOW_IMAP_HOST must be ${IMAP_HOST}`);
  }
  if (configuredSmtpPort && Number(configuredSmtpPort) !== SMTP_PORT) {
    throw new Error(`SOURCING_WORKFLOW_SMTP_PORT must be ${SMTP_PORT}`);
  }
  if (configuredImapPort && Number(configuredImapPort) !== IMAP_PORT) {
    throw new Error(`SOURCING_WORKFLOW_IMAP_PORT must be ${IMAP_PORT}`);
  }
}

function assertLoopbackMailAccount() {
  const password = process.env.SOURCING_WORKFLOW_MAIL_PASSWORD ?? MAIL_PASSWORD;
  if (password !== MAIL_PASSWORD) {
    throw new Error('SOURCING_WORKFLOW_MAIL_PASSWORD must match the isolated GreenMail fixture password');
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function quoteFixtureContent(prompt: string): string {
  const offerPattern = /^(?:邮件正文：)?Line (\d+) offer: ([A-Z0-9-]+); quantity (\d+) EA; unit price USD (\d+(?:\.\d+)?); condition ([A-Z0-9]+); certificate not required; tax excluded; freight excluded; Incoterm EXW; delivery (\d+) days; valid until (\d{4}-\d{2}-\d{2})\.$/gm;
  const items = [...prompt.matchAll(offerPattern)].map((match) => ({
    partNumber: match[2],
    quantity: Number(match[3]),
    quantityUnit: 'EA',
    unitPrice: Number(match[4]),
    currency: 'USD',
    leadTimeDays: Number(match[6]),
    validUntil: match[7],
    condition: match[5],
    certificate: 'NOT_REQUIRED',
    taxIncluded: false,
    freightIncluded: false,
    incoterm: 'EXW',
    evidenceText: match[0].replace(/^邮件正文：/, ''),
  }));
  return JSON.stringify({ items });
}

async function startModelFixture(): Promise<LocalFixture> {
  const requests: FixtureRequest[] = [];
  let failNextRequests = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'fixture route not found' }));
      return;
    }

    let body: JsonRecord;
    try {
      body = JSON.parse((await readRequestBody(request)).toString('utf8')) as JsonRecord;
    } catch {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((message): message is JsonRecord => Boolean(message && typeof message === 'object'))
      .map((message) => ({
        role: typeof message.role === 'string' ? message.role : '',
        content: typeof message.content === 'string' ? message.content : '',
      }));
    requests.push({
      method: request.method,
      url: request.url || '',
      host: request.headers.host,
      authorization: request.headers.authorization,
      model: typeof body.model === 'string' ? body.model : undefined,
      messages,
    });

    if (requests.length > 20) {
      response.statusCode = 429;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'fixture request limit exceeded', type: 'rate_limit_error' } }));
      return;
    }
    if (failNextRequests > 0) {
      failNextRequests -= 1;
      response.statusCode = 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'isolated fixture failure', type: 'server_error', code: 'fixture_failure' } }));
      return;
    }

    const prompt = messages.map((message) => message.content).join('\n');
    const content = quoteFixtureContent(prompt);
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: `sourcing-fixture-${requests.length}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: typeof body.model === 'string' ? body.model : 'sourcing-fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  const fixture: LocalFixture = {
    baseUrl: '',
    requests,
    get failNextRequests() { return failNextRequests; },
    set failNextRequests(value: number) { failNextRequests = value; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeIdleConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'local model fixture did not expose a TCP address');
  fixture.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return fixture;
}

function createAuthenticatedApp(
  actor: NonNullable<AuthRequest['user']>,
  modelActor: NonNullable<AuthRequest['user']>,
  routers: {
    rfqs: express.Router;
    inquiries: express.Router;
    tasks: express.Router;
    drafts: express.Router;
    supplierQuotes: express.Router;
    models: express.Router;
  },
  errorHandler: express.ErrorRequestHandler,
) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Mirrors the trusted auth handoff in checkAiModuleIntegration.ts while
  // exercising business capabilities as the seeded sales test user. Model
  // administration is isolated to the seeded manager account.
  app.use((request, _response, next) => {
    (request as AuthRequest).user = request.path.startsWith('/api/models') ? modelActor : actor;
    next();
  });
  app.use('/api/rfqs', routers.rfqs);
  app.use('/api/inquiries', routers.inquiries);
  app.use('/api/sourcing-ai-tasks', routers.tasks);
  app.use('/api/supplier-quote-drafts', routers.drafts);
  app.use('/api/supplier-quotes', routers.supplierQuotes);
  app.use('/api/models', routers.models);
  app.use(errorHandler);
  return app;
}

async function startExpressServer(app: express.Express): Promise<LocalHttpServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'route app did not expose a TCP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeIdleConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function callRoute(
  baseUrl: string,
  method: 'get' | 'post' | 'patch',
  path: string,
  body?: JsonRecord,
  idempotencyKey?: string,
): Promise<RouteResponse> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers,
    body: method === 'get' ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return {
    status: response.status,
    body: parsed && typeof parsed === 'object' ? parsed as JsonRecord : {},
  };
}

function successData(response: RouteResponse, label: string): JsonRecord {
  assert(response.status >= 200 && response.status < 300, `${label} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  assert(response.body.success === true, `${label} did not return success`);
  assert(response.body.data && typeof response.body.data === 'object', `${label} has no data payload`);
  return response.body.data as JsonRecord;
}

function assertStatus(response: RouteResponse, status: number, label: string) {
  assert(response.status === status, `${label} returned HTTP ${response.status}, expected ${status}: ${JSON.stringify(response.body)}`);
}

function idempotencyKey(label: string) {
  return `sourcing-workflow-${label}-${crypto.randomUUID()}`;
}

function normalizeMessageId(value: string | null | undefined) {
  return value?.replace(/\s+/g, '').replace(/^<+/, '').replace(/>+$/, '') || null;
}

function normalizeEmail(value: string | null | undefined) {
  if (!value) return '';
  const address = value.match(/<([^<>]+)>/)?.[1] ?? value;
  return address.trim().toLowerCase();
}

function replyBody(offers: SupplierOffer[], validUntil: string) {
  return offers.map((offer) =>
    `Line ${offer.lineNo} offer: ${offer.partNumber}; quantity ${offer.quantity} EA; unit price USD ${offer.unitPrice}; condition NE; certificate not required; tax excluded; freight excluded; Incoterm EXW; delivery ${offer.leadTimeDays} days; valid until ${validUntil}.`,
  ).join('\n');
}

function offersForSupplier(
  supplierId: string,
  lines: RfqLine[],
): SupplierOffer[] {
  const linePrices: Record<string, Record<number, { unitPrice: number; leadTimeDays: number }>> = {
    s001: {
      1: { unitPrice: 120, leadTimeDays: 8 },
      2: { unitPrice: 220, leadTimeDays: 12 },
    },
    s002: {
      2: { unitPrice: 195, leadTimeDays: 11 },
      3: { unitPrice: 82, leadTimeDays: 9 },
    },
    s003: {
      1: { unitPrice: 105, leadTimeDays: 6 },
      3: { unitPrice: 70, leadTimeDays: 7 },
    },
  };
  const pricing = linePrices[supplierId];
  assert(pricing, `no local quote fixture was defined for ${supplierId}`);
  return lines.map((line, index) => {
    const price = pricing[line.lineNo];
    assert(price, `supplier ${supplierId} was not expected to quote RFQ line ${line.lineNo}`);
    return {
      lineId: line.id,
      lineNo: index + 1,
      partNumber: line.partNumber,
      quantity: line.quantity,
      unitPrice: price.unitPrice,
      leadTimeDays: price.leadTimeDays,
      evidenceText: '',
    };
  });
}

function offersFromPersistedReply(
  body: string,
  inquiryItems: Array<{ id: string; lineNo: number; rfqLineId: string | null; partNumber: string; quantity: number }>,
): SupplierOffer[] {
  const pattern = /^Line (\d+) offer: ([A-Z0-9-]+); quantity (\d+) EA; unit price USD (\d+(?:\.\d+)?); condition ([A-Z0-9]+); certificate not required; tax excluded; freight excluded; Incoterm EXW; delivery (\d+) days; valid until (\d{4}-\d{2}-\d{2})\.$/gm;
  const matches = [...body.matchAll(pattern)];
  assert(matches.length === inquiryItems.length, 'persisted supplier reply no longer matches its inquiry line count');
  return matches.map((match, index) => {
    const item = inquiryItems[index];
    assert(item.rfqLineId && item.partNumber === match[2] && item.quantity === Number(match[3]),
      `persisted supplier reply line ${index + 1} does not map to its original inquiry item`);
    return {
      lineId: item.rfqLineId,
      lineNo: Number(match[1]),
      partNumber: match[2],
      quantity: Number(match[3]),
      unitPrice: Number(match[4]),
      leadTimeDays: Number(match[6]),
      evidenceText: match[0],
    };
  });
}

async function callLocalFixture(
  fixture: LocalFixture,
  messages: Array<{ role: string; content: string }>,
): Promise<JsonRecord> {
  const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MODEL_SECRET}` },
    body: JSON.stringify({ model: 'sourcing-fixture-model', messages }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as JsonRecord;
  assert(response.status === 200, `local fixture parsing validation returned HTTP ${response.status}`);
  const choices = payload.choices as Array<JsonRecord> | undefined;
  const message = choices?.[0]?.message as JsonRecord | undefined;
  assert(typeof message?.content === 'string', 'local fixture parsing validation returned no model content');
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    throw new Error('local fixture parsing validation returned invalid JSON');
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'local fixture parsing validation returned an invalid object');
  return parsed as JsonRecord;
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  complete: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!complete(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    last = await read();
  }
  assert(complete(last), `${label} did not reach its expected state within ${timeoutMs}ms`);
  return last;
}

function fixtureAccount(email: string) {
  return {
    id: `fixture-${email}`,
    email,
    displayName: email,
    imapServer: IMAP_HOST,
    imapPort: String(IMAP_PORT),
    smtpServer: SMTP_HOST,
    smtpPort: String(SMTP_PORT),
    authCode: MAIL_PASSWORD,
    accountType: 'custom',
  };
}

async function assertMailFixtureIsEmpty(fetchMailboxMessages: (account: ReturnType<typeof fixtureAccount>, options?: { afterUid?: number; limit?: number }) => Promise<{ emails: Array<{ uid: number }> }>) {
  const accounts = [BUYER_EMAIL, ...SUPPLIER_FIXTURES.map((supplier) => supplier.email)];
  for (const email of accounts) {
    const fetched = await fetchMailboxMessages(fixtureAccount(email), { afterUid: 0, limit: 100 });
    assert(fetched.emails.length === 0, `GreenMail inbox ${email} is not empty (${fetched.emails.length} existing messages)`);
  }
}

async function main() {
  assertIsolatedEnvironment();
  assertLoopbackMailAccount();

  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.EMAIL_MESSAGE_ID_DOMAIN = MAILBOX_DOMAIN;

  const [
    { default: prisma },
    { encrypt },
    { testSmtpConnection, testImapConnection, fetchMailboxMessages },
    { syncEmailAccount },
    { processOutboxEvent, OutboxChannel },
    { processPendingSourcingAiTasks, SUPPLIER_QUOTE_EXTRACTION_TASK },
    { renderAgentPrompts },
    { ensureBuiltinAgents },
    { default: rfqsRouter },
    { default: inquiriesRouter },
    { default: sourcingAiTasksRouter },
    { default: supplierQuoteDraftsRouter },
    { default: supplierQuotesRouter },
    { default: modelsRouter },
    { errorHandler },
  ] = await Promise.all([
    import('../lib/prisma.js'),
    import('../lib/crypto.js'),
    import('../lib/emailService.js'),
    import('../lib/inboundEmailSyncService.js'),
    import('../lib/outboxService.js'),
    import('../lib/sourcingAiTaskService.js'),
    import('../lib/aiAgentExecution.js'),
    import('../lib/aiAgentRegistry.js'),
    import('../routes/rfqs.js'),
    import('../routes/inquiries.js'),
    import('../routes/sourcingAiTasks.js'),
    import('../routes/supplierQuoteDrafts.js'),
    import('../routes/supplierQuotes.js'),
    import('../routes/models.js'),
    import('../middleware/errorHandler.js'),
  ]);

  let fixture: LocalFixture | undefined;
  let routeServer: LocalHttpServer | undefined;
  const supplierRuns: SupplierRun[] = [];
  let recoveryState: PartialRecovery | null = null;

  try {
    const probe = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    assert(Number(probe[0]?.ok) === 1, 'isolated PostgreSQL probe failed');

    if (process.env[MANUAL_FALLBACK_ONLY_ENV] === CONFIRMATION) {
      const counts = await Promise.all([
        prisma.rFQ.count(),
        prisma.inquiry.count(),
        prisma.inquiryItem.count(),
        prisma.email.count(),
        prisma.emailAccount.count(),
        prisma.emailSyncCursor.count(),
        prisma.inquiryEmailLink.count(),
        prisma.outboundEmail.count(),
        prisma.supplierQuoteDraft.count(),
        prisma.supplierQuote.count(),
        prisma.sourcingAiTask.count(),
        prisma.outboxEvent.count(),
        prisma.idempotencyRecord.count(),
        prisma.aIAgent.count(),
        prisma.aIModel.count(),
        prisma.aIAgentVersion.count(),
        prisma.agentLog.count(),
      ]);
      const beforeFallbackCounts = [6, 3, 6, 9, 1, 1, 4, 3, 3, 6, 4, 5, 7, 9, 5, 5, 4];
      const afterFallbackCounts = [6, 3, 6, 9, 1, 1, 4, 3, 4, 7, 4, 5, 7, 9, 5, 5, 4];
      const isFreshFallback = counts.every((count, index) => count === beforeFallbackCounts[index]);
      const isCompletedFallback = counts.every((count, index) => count === afterFallbackCounts[index]);
      assert(isFreshFallback || isCompletedFallback,
        `manual-fallback guard rejected the retained database state: ${counts.join(',')}`);

      const [rfqs, buyerAccount, suppliers, manager, salesUser] = await Promise.all([
        prisma.rFQ.findMany({ where: { notes: ACCEPTANCE_RFQ_NOTES }, select: { id: true, customerId: true, createdBy: true, status: true } }),
        prisma.emailAccount.findUnique({ where: { email: BUYER_EMAIL }, select: { id: true, imapServer: true, imapPort: true, smtpServer: true, smtpPort: true, isActive: true } }),
        prisma.supplier.findMany({ where: { id: { in: SUPPLIER_FIXTURES.map((supplier) => supplier.id) } }, select: { id: true, email: true } }),
        prisma.user.findUnique({ where: { id: MANAGER_ID }, select: { id: true, email: true, name: true, role: true, department: true, avatar: true } }),
        prisma.user.findUnique({ where: { id: SALES_USER_ID }, select: { id: true, email: true, name: true, role: true, department: true, avatar: true, isActive: true } }),
      ]);
      assert(rfqs.length === 1 && rfqs[0].customerId === CUSTOMER_ID && rfqs[0].createdBy === SALES_USER_ID && rfqs[0].status === 'PENDING',
        'manual-fallback guard did not find the exact retained sales RFQ');
      assert(buyerAccount?.isActive && buyerAccount.imapServer === IMAP_HOST && buyerAccount.imapPort === String(IMAP_PORT)
        && buyerAccount.smtpServer === SMTP_HOST && buyerAccount.smtpPort === String(SMTP_PORT),
      'manual-fallback guard rejected a non-loopback buyer email account');
      assert(suppliers.length === 3 && SUPPLIER_FIXTURES.every((expected) =>
        suppliers.some((supplier) => supplier.id === expected.id && supplier.email === expected.email)),
      'manual-fallback guard rejected the supplier mailbox fixture');
      assert(manager?.role.toLowerCase() === 'manager' && salesUser?.isActive && salesUser.role.toLowerCase() === 'sales',
        'manual-fallback guard requires the seeded manager and active sales user');

      const rfqId = rfqs[0].id;
      const [lines, inquiries, failureEmails] = await Promise.all([
        prisma.rfqLine.findMany({ where: { rfqId }, orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, partNumber: true, quantity: true, uom: true } }),
        prisma.inquiry.findMany({ where: { rfqId }, include: { items: { orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, rfqLineId: true, partNumber: true, quantity: true } } } }),
        prisma.email.findMany({
          where: {
            accountId: buyerAccount.id,
            from: { contains: 'supplier1@sourcing.test' },
            subject: { startsWith: 'Re: follow-up sourcing acceptance ' },
            threadMatchStatus: 'MATCHED',
          },
          select: { id: true, from: true, subject: true, body: true, threadMatchReason: true, messageId: true },
        }),
      ]);
      assert(lines.length === 3 && lines[0].partNumber === lines[1].partNumber,
        'manual-fallback guard requires the retained three-line RFQ with duplicate part numbers');
      assert(inquiries.length === 3, 'manual-fallback guard requires the three retained supplier inquiries');
      const inquiry = inquiries.find((candidate) => candidate.supplierId === 's001');
      assert(inquiry && inquiry.items.length === 2, 'manual-fallback guard requires s001 coverage of the first two demand lines');
      assert(failureEmails.length === 1 && normalizeEmail(failureEmails[0].from) === 'supplier1@sourcing.test'
        && failureEmails[0].threadMatchReason === 'MESSAGE_ID_AND_SUPPLIER_EMAIL_MATCH',
      'manual-fallback guard could not uniquely locate the real model-failure reply');
      const failureEmail = failureEmails[0];
      const failureLink = await prisma.inquiryEmailLink.findUnique({
        where: { emailId_inquiryId: { emailId: failureEmail.id, inquiryId: inquiry.id } },
        select: { confirmationStatus: true, method: true },
      });
      const failedTask = await prisma.sourcingAiTask.findFirst({
        where: { emailId: failureEmail.id, inquiryId: inquiry.id, status: 'FAILED' },
        select: { id: true, draftId: true, errorSummary: true },
      });
      assert(failureLink?.confirmationStatus === 'CONFIRMED' && failureLink.method === 'AUTO_MESSAGE_ID',
        'manual fallback requires a confirmed exact-message-ID reply link');
      assert(failedTask && failedTask.draftId === null,
        'manual fallback requires a genuine failed extraction task without an AI-created draft');
      const manualEvidence = failureEmail.body?.split(/\r?\n/).find((line) => line.startsWith('Line 1 offer:'));
      assert(manualEvidence, 'model-failure email does not contain the expected line-1 source evidence');

      const firstLine = lines[0];
      const firstInquiryItem = inquiry.items.find((item) => item.lineNo === 1);
      assert(firstInquiryItem?.rfqLineId === firstLine.id && firstInquiryItem.partNumber === firstLine.partNumber
        && firstInquiryItem.quantity === firstLine.quantity,
      'manual fallback cannot explicitly bind its duplicate part number to RFQ line 1');
      const rfqLineIds = lines.map((line) => line.id);
      const existingDrafts = await prisma.supplierQuoteDraft.findMany({
        where: { emailId: failureEmail.id, inquiryId: inquiry.id },
        orderBy: { version: 'asc' },
        select: { id: true, status: true, version: true, payloadJson: true },
      });
      const fallbackItemKey = `manual-fallback-${rfqId}`;
      type ManualDraftRecord = { id: string; status: string; version: number; payloadJson: string };
      const existingManualDraft = existingDrafts.at(-1);
      let manualDraft: ManualDraftRecord | null = existingManualDraft ? {
        id: existingManualDraft.id,
        status: existingManualDraft.status,
        version: existingManualDraft.version,
        payloadJson: existingManualDraft.payloadJson,
      } : null;
      let manualFallbackQuote = manualDraft
        ? await prisma.supplierQuote.findFirst({ where: { sourceDraftId: manualDraft.id }, select: { id: true, sourceDraftItemKey: true, rfqId: true, rfqLineId: true, inquiryId: true, inquiryItemId: true, supplierId: true, partNumber: true, quantity: true, quantityUnit: true, unitPrice: true, currency: true, leadTimeDays: true, isWinner: true, status: true } })
        : null;
      assert((isFreshFallback && existingDrafts.length === 0 && !manualFallbackQuote)
        || (isCompletedFallback && existingDrafts.length === 1 && manualDraft?.status === 'CONFIRMED' && manualFallbackQuote),
      'manual-fallback guard found an unexpected pre-existing draft or quote for the failure reply');

      const allQuotesBefore = await prisma.supplierQuote.findMany({
        where: { rfqLineId: { in: rfqLineIds } },
        orderBy: { id: 'asc' },
        select: { id: true, rfqLineId: true, supplierId: true, inquiryId: true, inquiryItemId: true, partNumber: true, quantity: true, quantityUnit: true, unitPrice: true, currency: true, leadTimeDays: true, sourceDraftId: true, sourceDraftItemKey: true, isWinner: true, status: true, updatedAt: true },
      });
      const baselineQuotes = allQuotesBefore.filter((quote) => quote.sourceDraftId !== manualDraft?.id);
      assert(baselineQuotes.length === 6, `manual fallback expected the original six quotes, found ${baselineQuotes.length}`);
      const originalQuoteSnapshot = baselineQuotes.map((quote) => ({
        id: quote.id,
        rfqLineId: quote.rfqLineId,
        supplierId: quote.supplierId,
        inquiryId: quote.inquiryId,
        inquiryItemId: quote.inquiryItemId,
        partNumber: quote.partNumber,
        quantity: quote.quantity,
        quantityUnit: quote.quantityUnit,
        unitPrice: quote.unitPrice,
        currency: quote.currency,
        leadTimeDays: quote.leadTimeDays,
        sourceDraftId: quote.sourceDraftId,
        sourceDraftItemKey: quote.sourceDraftItemKey,
        isWinner: quote.isWinner,
        status: quote.status,
        updatedAt: quote.updatedAt.toISOString(),
      }));
      const originalWinnerIds = lines.map((line) => {
        const winners = baselineQuotes.filter((quote) => quote.rfqLineId === line.id && quote.isWinner);
        assert(winners.length === 1, `RFQ line ${line.lineNo} has ${winners.length} winners before manual fallback`);
        return { lineNo: line.lineNo, rfqLineId: line.id, quoteId: winners[0].id, supplierId: winners[0].supplierId, unitPrice: winners[0].unitPrice };
      });
      const expectedWinners = [
        { lineNo: 1, supplierId: 's003', unitPrice: 105 },
        { lineNo: 2, supplierId: 's002', unitPrice: 195 },
        { lineNo: 3, supplierId: 's003', unitPrice: 70 },
      ];
      for (const expected of expectedWinners) {
        const line = lines.find((candidate) => candidate.lineNo === expected.lineNo)!;
        assert(originalWinnerIds.some((winner) => winner.rfqLineId === line.id
          && winner.supplierId === expected.supplierId && winner.unitPrice === expected.unitPrice),
        `manual fallback guard found an unexpected pre-existing winner for line ${expected.lineNo}`);
      }

      const actor = {
        id: salesUser.id,
        email: salesUser.email,
        name: salesUser.name,
        role: salesUser.role,
        department: salesUser.department,
        avatar: salesUser.avatar,
      };
      const modelActor = {
        id: manager.id,
        email: manager.email,
        name: manager.name,
        role: manager.role,
        department: manager.department,
        avatar: manager.avatar,
      };
      routeServer = await startExpressServer(createAuthenticatedApp(actor, modelActor, {
        rfqs: rfqsRouter,
        inquiries: inquiriesRouter,
        tasks: sourcingAiTasksRouter,
        drafts: supplierQuoteDraftsRouter,
        supplierQuotes: supplierQuotesRouter,
        models: modelsRouter,
      }, errorHandler));

      if (!manualDraft) {
        const createDraftResponse = await callRoute(routeServer.baseUrl, 'post', '/api/supplier-quote-drafts', {
          emailId: failureEmail.id,
          inquiryId: inquiry.id,
          payload: { items: [{ itemKey: fallbackItemKey, partNumber: firstInquiryItem.partNumber, evidenceText: manualEvidence }] },
        });
        assertStatus(createDraftResponse, 201, 'manual fallback draft creation');
        const createdManualDraft = successData(createDraftResponse, 'manual fallback draft creation');
        assert(createdManualDraft.status === 'DRAFT' && Number(createdManualDraft.version) === 1,
          'manual fallback draft did not begin as a non-AI version-1 draft');
        assert(createdManualDraft.aiModel === null && createdManualDraft.aiPromptVersion === null && createdManualDraft.aiMetadata === null,
          'manual fallback draft unexpectedly claims AI provenance');
        manualDraft = {
          id: String(createdManualDraft.id),
          status: String(createdManualDraft.status),
          version: Number(createdManualDraft.version),
          payloadJson: JSON.stringify(createdManualDraft.payload),
        };
      } else {
        const storedPayload = JSON.parse(manualDraft.payloadJson) as { items?: Array<{ itemKey?: string }> };
        assert(storedPayload.items?.length === 1 && storedPayload.items[0].itemKey === fallbackItemKey,
          'existing failure-reply draft is not the exact manual-fallback record');
        assert(manualFallbackQuote?.sourceDraftItemKey === fallbackItemKey,
          'existing manual fallback quote lost its exact draft-item source binding');
      }

      const manualPayload = {
        items: [{
          itemKey: fallbackItemKey,
          inquiryItemId: firstInquiryItem.id,
          partNumber: firstInquiryItem.partNumber,
          quantityUnit: firstLine.uom,
          quantity: firstInquiryItem.quantity,
          unitPrice: 9999,
          currency: 'USD',
          leadTimeDays: 30,
          validUntil: '2030-12-31',
          condition: 'NE',
          certificate: 'Not required',
          taxIncluded: false,
          freightIncluded: false,
          incoterm: 'EXW',
          evidenceText: manualEvidence,
          notes: 'Manually transcribed after local model failure; explicit duplicate-line binding.',
        }],
      };
      if (manualDraft.status === 'DRAFT') {
        const patchResponse = await callRoute(routeServer.baseUrl, 'patch', `/api/supplier-quote-drafts/${encodeURIComponent(manualDraft.id)}`, {
          expectedVersion: Number(manualDraft.version),
          payload: manualPayload,
        });
        const patchedDraft = successData(patchResponse, 'manual fallback draft revision');
        assert(patchedDraft.status === 'DRAFT' && Number(patchedDraft.version) === Number(manualDraft.version) + 1,
          'manual fallback revision did not advance the editable draft version');
        const confirmPath = `/api/supplier-quote-drafts/${encodeURIComponent(manualDraft.id)}/confirm`;
        const firstConfirm = successData(await callRoute(routeServer.baseUrl, 'post', confirmPath, { expectedVersion: Number(patchedDraft.version) }),
          'manual fallback formal quote confirmation');
        assert(firstConfirm.status === 'CONFIRMED' && firstConfirm.reused === false,
          'manual fallback confirmation did not create a formal quote');
        const createdIds = firstConfirm.supplierQuoteIds as string[];
        assert(createdIds?.length === 1, 'manual fallback confirmation did not create exactly one line quote');
        manualFallbackQuote = await prisma.supplierQuote.findUniqueOrThrow({
          where: { id: createdIds[0] },
          select: { id: true, sourceDraftItemKey: true, rfqId: true, rfqLineId: true, inquiryId: true, inquiryItemId: true, supplierId: true, partNumber: true, quantity: true, quantityUnit: true, unitPrice: true, currency: true, leadTimeDays: true, isWinner: true, status: true },
        });
      }

      assert(manualDraft && manualFallbackQuote, 'manual fallback did not retain its draft and formal quote');
      let repeatedConfirmReusedSameQuote = isCompletedFallback;
      if (!isCompletedFallback) {
        const confirmPath = `/api/supplier-quote-drafts/${encodeURIComponent(manualDraft.id)}/confirm`;
        const repeatedConfirm = successData(await callRoute(routeServer.baseUrl, 'post', confirmPath, {
          expectedVersion: Number(manualDraft.version) + 1,
        }), 'repeated manual fallback confirmation');
        assert(repeatedConfirm.reused === true && (repeatedConfirm.supplierQuoteIds as string[]).includes(manualFallbackQuote.id),
          'repeated manual fallback confirmation did not reuse its existing quote');
        repeatedConfirmReusedSameQuote = true;
      }
      assert(manualFallbackQuote.sourceDraftItemKey === fallbackItemKey
        && manualFallbackQuote.rfqId === rfqId && manualFallbackQuote.rfqLineId === firstLine.id
        && manualFallbackQuote.inquiryId === inquiry.id && manualFallbackQuote.inquiryItemId === firstInquiryItem.id
        && manualFallbackQuote.supplierId === 's001' && manualFallbackQuote.partNumber === firstLine.partNumber
        && manualFallbackQuote.quantity === firstLine.quantity && manualFallbackQuote.quantityUnit === firstLine.uom
        && manualFallbackQuote.unitPrice === 9999 && manualFallbackQuote.currency === 'USD'
        && manualFallbackQuote.leadTimeDays === 30 && manualFallbackQuote.isWinner === false,
      'manual fallback quote lost its explicit demand/source binding or would alter the current winner');

      const allQuotesAfter = await prisma.supplierQuote.findMany({
        where: { rfqLineId: { in: rfqLineIds } },
        orderBy: { id: 'asc' },
        select: { id: true, rfqLineId: true, supplierId: true, inquiryId: true, inquiryItemId: true, partNumber: true, quantity: true, quantityUnit: true, unitPrice: true, currency: true, leadTimeDays: true, sourceDraftId: true, sourceDraftItemKey: true, isWinner: true, status: true, updatedAt: true },
      });
      const baselineQuotesAfter = allQuotesAfter.filter((quote) => quote.sourceDraftId !== manualDraft!.id);
      const snapshotAfter = baselineQuotesAfter.map((quote) => ({
        id: quote.id,
        rfqLineId: quote.rfqLineId,
        supplierId: quote.supplierId,
        inquiryId: quote.inquiryId,
        inquiryItemId: quote.inquiryItemId,
        partNumber: quote.partNumber,
        quantity: quote.quantity,
        quantityUnit: quote.quantityUnit,
        unitPrice: quote.unitPrice,
        currency: quote.currency,
        leadTimeDays: quote.leadTimeDays,
        sourceDraftId: quote.sourceDraftId,
        sourceDraftItemKey: quote.sourceDraftItemKey,
        isWinner: quote.isWinner,
        status: quote.status,
        updatedAt: quote.updatedAt.toISOString(),
      }));
      assert(JSON.stringify(snapshotAfter) === JSON.stringify(originalQuoteSnapshot),
        'manual fallback modified one or more of the six previously confirmed supplier quotes');
      const winnerIdsAfter = lines.map((line) => {
        const winners = baselineQuotesAfter.filter((quote) => quote.rfqLineId === line.id && quote.isWinner);
        assert(winners.length === 1, `manual fallback left ${winners.length} original winners on RFQ line ${line.lineNo}`);
        return { lineNo: line.lineNo, rfqLineId: line.id, quoteId: winners[0].id, supplierId: winners[0].supplierId, unitPrice: winners[0].unitPrice };
      });
      assert(JSON.stringify(winnerIdsAfter) === JSON.stringify(originalWinnerIds),
        'manual fallback changed one or more of the three existing selected winners');
      assert(repeatedConfirmReusedSameQuote,
        'manual fallback repeat-confirm idempotency was not verified on the initial write run');
      assert(allQuotesAfter.length === 7, `manual fallback expected seven total RFQ quotes, found ${allQuotesAfter.length}`);

      const compareResponse = successData(await callRoute(routeServer.baseUrl, 'post', '/api/supplier-quotes/compare', {
        rfqId,
        rfqLineId: firstLine.id,
      }), 'manual fallback line comparison');
      const compared = compareResponse.quotes as Array<JsonRecord>;
      assert(compareResponse.rfqLineId === firstLine.id && compared.length === 3,
        'manual fallback offer is not visible as the third line-1 comparison candidate');
      const originalWinnerInComparison = compared.find((quote) => quote.id === originalWinnerIds[0].quoteId);
      const manualQuoteInComparison = compared.find((quote) => quote.id === manualFallbackQuote.id);
      assert(originalWinnerInComparison?.isWinner === true && Number(originalWinnerInComparison.unitPrice) === 105
        && originalWinnerInComparison.eligibleForComparison === true
        && manualQuoteInComparison?.isWinner === false && Number(manualQuoteInComparison.unitPrice) === 9999
        && manualQuoteInComparison.eligibleForComparison === true,
      `manual fallback comparison changed the original lowest-price selection: ${JSON.stringify({
        summary: compareResponse.summary,
        originalWinnerId: originalWinnerIds[0].quoteId,
        quotes: compared.map((quote) => ({ id: quote.id, unitPrice: quote.unitPrice, isWinner: quote.isWinner, eligibleForComparison: quote.eligibleForComparison })),
      })}`);
      const partNumberGroups = (compareResponse.partNumberGroups as Array<JsonRecord> | undefined) ?? [];
      const comparisonBasisEvidence = partNumberGroups.flatMap((partGroup) =>
        ((partGroup.commercialBasisGroups as Array<JsonRecord> | undefined) ?? []).map((group) => ({
          partNumber: partGroup.partNumber,
          label: group.label,
          lowestPrice: (group.summary as JsonRecord | undefined)?.lowestPrice ?? null,
          quoteIds: ((group.quotes as Array<JsonRecord> | undefined) ?? []).map((quote) => quote.id),
        })));

      resultArtifact.ok = true;
      resultArtifact.manualFallbackScenario = {
        database: DATABASE_NAME,
        rfqId,
        failureEmailId: failureEmail.id,
        failedTaskId: failedTask.id,
        aiTaskStatus: 'FAILED',
        manualDraftId: manualDraft.id,
        manualDraftVersion: Number(manualDraft.version) + (manualDraft.status === 'DRAFT' ? 1 : 0),
        manualDraftStatus: 'CONFIRMED',
        manualQuoteId: manualFallbackQuote.id,
        manualQuoteCount: 1,
        affectedDemandLine: { lineNo: firstLine.lineNo, rfqLineId: firstLine.id, partNumber: firstLine.partNumber, supplierId: 's001', comparisonCandidateCount: compared.length },
        repeatedConfirmReusedSameQuote,
        originalSixQuoteIdsPreserved: originalQuoteSnapshot.map((quote) => quote.id),
        originalSixQuoteFieldsUnchanged: true,
        originalWinnersUnchanged: originalWinnerIds,
        lineComparison: {
          candidateCount: compared.length,
          partNumberGroupCount: partNumberGroups.length,
          topLevelLowestPrice: (compareResponse.summary as JsonRecord).lowestPrice ?? null,
          commercialBasisGroups: comparisonBasisEvidence,
          comparisonReason: (compareResponse.metadata as JsonRecord | undefined)?.reason ?? null,
          originalWinnerStillSelected: originalWinnerInComparison.isWinner === true,
        },
        preservedLoopbackDatabase: true,
        safeReplay: isCompletedFallback,
      };
      console.log(JSON.stringify(resultArtifact));
      return;
    }

    const workflowCounts = await Promise.all([
      prisma.rFQ.count(),
      prisma.inquiry.count(),
      prisma.inquiryItem.count(),
      prisma.email.count(),
      prisma.emailAccount.count(),
      prisma.emailSyncCursor.count(),
      prisma.inquiryEmailLink.count(),
      prisma.outboundEmail.count(),
      prisma.supplierQuoteDraft.count(),
      prisma.supplierQuote.count(),
      prisma.sourcingAiTask.count(),
      prisma.outboxEvent.count(),
      prisma.idempotencyRecord.count(),
      prisma.aIAgent.count(),
      prisma.aIModel.count(),
      prisma.aIAgentVersion.count(),
      prisma.agentLog.count(),
    ]);
    const expectedSeedCounts = [5, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 0];
    const interruptedRunCounts = [6, 1, 2, 5, 1, 0, 0, 1, 0, 0, 0, 3, 3, 9, 5, 5, 0];
    const completedDraftRecoveryCounts = [6, 3, 6, 8, 1, 1, 3, 3, 3, 0, 3, 5, 7, 9, 5, 5, 3];
    const isFreshRun = workflowCounts.every((count, index) => count === expectedSeedCounts[index]);
    const isQueuedRecovery = workflowCounts.every((count, index) => count === interruptedRunCounts[index]);
    const isDraftReadyRecovery = workflowCounts.every((count, index) => count === completedDraftRecoveryCounts[index]);
    const isRecognizedInterruptedRun = isQueuedRecovery || isDraftReadyRecovery;
    assert(isFreshRun || isRecognizedInterruptedRun,
      `one-time database guard failed; expected the untouched demo baseline or the exact interrupted fixture, observed ${workflowCounts.join(',')}`);

    const [baselineRfqs, baselineEmails, baselineAgents, baselineModels] = await Promise.all([
      prisma.rFQ.findMany({ select: { id: true, notes: true, createdBy: true, customerId: true, status: true }, orderBy: { id: 'asc' } }),
      prisma.email.findMany({ select: { id: true, accountId: true, messageId: true }, orderBy: { id: 'asc' } }),
      prisma.aIAgent.findMany({ select: { id: true, builtinKey: true, publishedVersion: true }, orderBy: { id: 'asc' } }),
      prisma.aIModel.findMany({ select: { id: true, name: true, modelId: true, baseUrl: true, isActive: true, isDefault: true }, orderBy: { id: 'asc' } }),
    ]);
    const seedRfqIds = baselineRfqs.map((row) => row.id).filter((id) => /^rfq00[1-5]$/.test(id)).sort();
    assert(seedRfqIds.join(',') === 'rfq001,rfq002,rfq003,rfq004,rfq005'
      && baselineRfqs.filter((row) => !/^rfq00[1-5]$/.test(row.id)).length === (isFreshRun ? 0 : 1),
      'one-time database guard found a non-demo RFQ baseline');
    const seededEmails = baselineEmails.filter((row) => /^e00[1-5]$/.test(row.id)).sort((a, b) => a.id.localeCompare(b.id));
    assert(seededEmails.map((row) => row.id).join(',') === 'e001,e002,e003,e004,e005'
      && seededEmails.every((row) => row.accountId === null && row.messageId === null)
      && baselineEmails.length === (isDraftReadyRecovery ? 8 : 5),
    'one-time database guard found non-demo or previously synchronized email rows');
    const seededAgentIds = baselineAgents.filter((row) => row.builtinKey === null).map((row) => row.id).sort();
    const builtinAgentKeys = baselineAgents.filter((row) => row.builtinKey !== null).map((row) => row.builtinKey).sort();
    assert(seededAgentIds.join(',') === 'agent001,agent002,agent003,agent004'
      && (isFreshRun
        ? builtinAgentKeys.length === 0
        : builtinAgentKeys.join(',') === 'business_chat,customer_email,quote_analysis,rfq_extraction,supplier_quote_extraction'
          && baselineAgents.filter((row) => row.builtinKey !== null).every((row) => row.publishedVersion === 1)),
    'one-time database guard found unexpected AI agents');
    const seededModelIds = baselineModels.filter((row) => /^model00[1-4]$/.test(row.id)).map((row) => row.id).sort();
    const fixtureModels = baselineModels.filter((row) => row.modelId === 'sourcing-fixture-model'
      && row.name.startsWith('Sourcing workflow local fixture ')
      && row.baseUrl?.startsWith('http://127.0.0.1:')
      && row.isActive);
    assert(seededModelIds.join(',') === 'model001,model002,model003,model004'
      && (isFreshRun ? baselineModels.length === 4 : fixtureModels.length === 1 && baselineModels.length === 5),
      'one-time database guard found unexpected AI models');

    if (isQueuedRecovery) {
      const markerRfqs = baselineRfqs.filter((row) => row.notes === ACCEPTANCE_RFQ_NOTES);
      assert(markerRfqs.length === 1, 'interrupted-run recovery requires exactly one RFQ with the acceptance marker');
      const rfq = markerRfqs[0];
      assert(rfq.createdBy === SALES_USER_ID && rfq.customerId === CUSTOMER_ID && rfq.status === 'PENDING',
        'interrupted-run RFQ owner, customer, or status differs from the acceptance fixture');

      const [lines, inquiries, accounts, outboundEmails, inquiryEvents, rfqEvents, idempotencyRows] = await Promise.all([
        prisma.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, partNumber: true, quantity: true } }),
        prisma.inquiry.findMany({ where: { rfqId: rfq.id }, include: { items: true, emailLinks: true } }),
        prisma.emailAccount.findMany({ where: { email: BUYER_EMAIL }, select: { id: true, imapServer: true, imapPort: true, smtpServer: true, smtpPort: true, isActive: true, isDefault: true } }),
        prisma.outboundEmail.findMany({ where: { inquiry: { rfqId: rfq.id } }, select: { id: true, inquiryId: true, accountId: true, purpose: true, toEmail: true, status: true } }),
        prisma.outboxEvent.findMany({ where: { aggregateType: 'INQUIRY', eventType: 'inquiry.email.send' }, select: { id: true, aggregateId: true, status: true } }),
        prisma.outboxEvent.findMany({ where: { aggregateType: 'RFQ', aggregateId: rfq.id }, select: { id: true, eventType: true, status: true } }),
        prisma.idempotencyRecord.findMany({ select: { scope: true, resourceType: true, resourceId: true } }),
      ]);
      assert(lines.length === 3
        && lines[0].partNumber === 'SWF-DUPLICATE-001' && lines[0].quantity === 2
        && lines[1].partNumber === 'SWF-DUPLICATE-001' && lines[1].quantity === 3
        && lines[2].partNumber === 'SWF-THIRD-003' && lines[2].quantity === 1,
      'interrupted-run RFQ demand lines differ from the acceptance fixture');
      assert(inquiries.length === 1 && inquiries[0].supplierId === 's001' && inquiries[0].status === 'QUEUED'
        && inquiries[0].items.length === 2
        && inquiries[0].items.map((item) => item.rfqLineId).sort().join(',') === lines.slice(0, 2).map((line) => line.id).sort().join(','),
      'interrupted-run inquiry differs from the first supplier scope');
      assert(accounts.length === 1 && accounts[0].imapServer === IMAP_HOST && accounts[0].imapPort === String(IMAP_PORT)
        && accounts[0].smtpServer === SMTP_HOST && accounts[0].smtpPort === String(SMTP_PORT)
        && accounts[0].isActive && accounts[0].isDefault,
      'interrupted-run buyer account is not bound to the exact active loopback mail fixture');
      assert(outboundEmails.length === 1 && outboundEmails[0].inquiryId === inquiries[0].id
        && outboundEmails[0].accountId === accounts[0].id && outboundEmails[0].purpose === 'INQUIRY_SEND'
        && outboundEmails[0].toEmail === SUPPLIER_FIXTURES[0].email && outboundEmails[0].status === 'PENDING',
      'interrupted-run outbound email is not the exact pending first-supplier fixture');
      assert(inquiryEvents.length === 1 && inquiryEvents[0].aggregateId === inquiries[0].id && inquiryEvents[0].status === 'PENDING',
        'interrupted-run inquiry outbox is not the exact pending send event');
      assert(rfqEvents.length === 2 && rfqEvents.every((event) => event.eventType === 'rfq.created' && event.status === 'PENDING'),
        'interrupted-run RFQ outbox differs from the exact observed route-created baseline');
      assert(idempotencyRows.length === 3
        && idempotencyRows.some((row) => row.scope === 'POST:/rfqs' && row.resourceId === rfq.id)
        && idempotencyRows.some((row) => row.scope === 'POST:/inquiries' && row.resourceId === rfq.id)
        && idempotencyRows.some((row) => row.scope === `POST:/inquiries/${inquiries[0].id}/send` && row.resourceId === inquiries[0].id),
      'interrupted-run idempotency records differ from the exact three route calls');

      recoveryState = {
        stage: 'send-queued',
        rfqId: rfq.id,
        inquiryId: inquiries[0].id,
        outboundEmailId: outboundEmails[0].id,
        outboxEventId: inquiryEvents[0].id,
        emailAccountId: accounts[0].id,
        modelId: fixtureModels[0]!.id,
      };
      console.warn(JSON.stringify({ recovery: 'exact-interrupted-fixture', rfqId: recoveryState.rfqId, inquiryId: recoveryState.inquiryId }));
    }

    if (isDraftReadyRecovery) {
      const markerRfqs = baselineRfqs.filter((row) => row.notes === ACCEPTANCE_RFQ_NOTES);
      assert(markerRfqs.length === 1, 'draft recovery requires exactly one RFQ with the acceptance marker');
      const rfq = markerRfqs[0];
      assert(rfq.createdBy === SALES_USER_ID && rfq.customerId === CUSTOMER_ID && rfq.status === 'PENDING',
        'draft-recovery RFQ owner, customer, or status differs from the acceptance fixture');
      const [lines, inquiries, accounts, emails, links, outboundEmails, inquiryEvents, rfqEvents, idempotencyRows, drafts, tasks, cursor, logs] = await Promise.all([
        prisma.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, partNumber: true, quantity: true } }),
        prisma.inquiry.findMany({ where: { rfqId: rfq.id }, include: { items: true, emailLinks: true } }),
        prisma.emailAccount.findMany({ where: { email: BUYER_EMAIL }, select: { id: true, imapServer: true, imapPort: true, smtpServer: true, smtpPort: true, isActive: true, isDefault: true } }),
        prisma.email.findMany({ where: { account: { is: { email: BUYER_EMAIL } } }, orderBy: { receivedAt: 'asc' }, select: { id: true, from: true, body: true, messageId: true, inReplyTo: true, references: true, threadMatchStatus: true, threadMatchReason: true } }),
        prisma.inquiryEmailLink.findMany({ select: { id: true, emailId: true, inquiryId: true, confirmationStatus: true, method: true } }),
        prisma.outboundEmail.findMany({ where: { inquiry: { is: { rfqId: rfq.id } } }, select: { id: true, inquiryId: true, accountId: true, purpose: true, toEmail: true, status: true, providerMessageId: true } }),
        prisma.outboxEvent.findMany({ where: { aggregateType: 'INQUIRY', eventType: 'inquiry.email.send' }, select: { id: true, aggregateId: true, status: true } }),
        prisma.outboxEvent.findMany({ where: { aggregateType: 'RFQ', aggregateId: rfq.id }, select: { id: true, eventType: true, status: true } }),
        prisma.idempotencyRecord.findMany({ select: { scope: true, resourceType: true, resourceId: true } }),
        prisma.supplierQuoteDraft.findMany({ select: { id: true, emailId: true, inquiryId: true, status: true, version: true, payloadJson: true } }),
        prisma.sourcingAiTask.findMany({ select: { id: true, emailId: true, inquiryId: true, status: true, draftId: true } }),
        prisma.emailSyncCursor.findMany({ where: { account: { is: { email: BUYER_EMAIL } } }, select: { lastUid: true, mailbox: true } }),
        prisma.agentLog.findMany({ where: { action: 'business.extract-supplier-quote-email' }, select: { id: true, status: true } }),
      ]);
      assert(lines.length === 3
        && lines[0].partNumber === 'SWF-DUPLICATE-001' && lines[0].quantity === 2
        && lines[1].partNumber === 'SWF-DUPLICATE-001' && lines[1].quantity === 3
        && lines[2].partNumber === 'SWF-THIRD-003' && lines[2].quantity === 1,
      'draft-recovery RFQ demand lines differ from the acceptance fixture');
      assert(inquiries.length === 3 && SUPPLIER_FIXTURES.every((supplier) => inquiries.some((inquiry) => inquiry.supplierId === supplier.id))
        && inquiries.every((inquiry) => inquiry.status === 'SENT' && inquiry.items.length === 2),
      'draft-recovery supplier inquiries differ from the sent acceptance scopes');
      assert(accounts.length === 1 && accounts[0].imapServer === IMAP_HOST && accounts[0].imapPort === String(IMAP_PORT)
        && accounts[0].smtpServer === SMTP_HOST && accounts[0].smtpPort === String(SMTP_PORT)
        && accounts[0].isActive && accounts[0].isDefault,
      'draft-recovery buyer account is not bound to the exact active loopback mail fixture');
      assert(emails.length === 3 && emails.every((email) => email.messageId && email.inReplyTo
        && email.threadMatchStatus === 'MATCHED' && email.threadMatchReason === 'MESSAGE_ID_AND_SUPPLIER_EMAIL_MATCH'),
      'draft-recovery inbound replies do not preserve threading and automatic matching evidence');
      assert(links.length === 3 && links.every((link) => link.confirmationStatus === 'CONFIRMED' && link.method === 'AUTO_MESSAGE_ID')
        && links.every((link) => emails.some((email) => email.id === link.emailId) && inquiries.some((inquiry) => inquiry.id === link.inquiryId)),
      'draft-recovery inquiry/email links are not the exact confirmed automatic matches');
      assert(outboundEmails.length === 3 && outboundEmails.every((email) => email.accountId === accounts[0].id
        && email.purpose === 'INQUIRY_SEND' && email.status === 'SENT' && email.providerMessageId)
        && SUPPLIER_FIXTURES.every((supplier) => outboundEmails.some((email) => email.toEmail === supplier.email)),
      'draft-recovery outbound inquiry emails do not represent three sent loopback messages');
      assert(inquiryEvents.length === 3 && inquiryEvents.every((event) => event.status === 'DELIVERED')
        && inquiryEvents.every((event) => inquiries.some((inquiry) => inquiry.id === event.aggregateId)),
      'draft-recovery outbox does not contain three delivered inquiry sends');
      assert(rfqEvents.length === 2 && rfqEvents.every((event) => event.eventType === 'rfq.created' && event.status === 'PENDING'),
        'draft-recovery RFQ outbox differs from the exact observed route-created baseline');
      assert(idempotencyRows.length === 7
        && idempotencyRows.filter((row) => row.scope === 'POST:/rfqs' && row.resourceId === rfq.id).length === 1
        && idempotencyRows.filter((row) => row.scope === 'POST:/inquiries' && row.resourceId === rfq.id).length === 3
        && idempotencyRows.filter((row) => row.scope.includes('/send') && inquiries.some((inquiry) => row.resourceId === inquiry.id)).length === 3,
      'draft-recovery idempotency records differ from the expected RFQ/inquiry/send route calls');
      assert(drafts.length === 3 && drafts.every((draft) => draft.status === 'DRAFT'
        && inquiries.some((inquiry) => inquiry.id === draft.inquiryId && inquiry.emailLinks.some((link) => link.emailId === draft.emailId))),
      'draft-recovery editable drafts are not bound to their matched inquiries and reply emails');
      assert(tasks.length === 3 && tasks.every((task) => task.status === 'COMPLETED'
        && drafts.some((draft) => draft.id === task.draftId && draft.emailId === task.emailId && draft.inquiryId === task.inquiryId)),
      'draft-recovery AI tasks are not three completed tasks linked to their editable drafts');
      assert(cursor.length === 1 && cursor[0].mailbox === 'INBOX' && cursor[0].lastUid === 3,
        'draft-recovery IMAP cursor does not represent the three already-ingested replies');
      assert(logs.length === 3 && logs.every((log) => log.status === 'SUCCESS'),
        'draft-recovery model execution logs do not represent three successful extraction calls');
      const initialDraftShape = drafts.every((draft) => draft.version === 1
        && (JSON.parse(draft.payloadJson) as { items?: unknown[] }).items?.length === 1);
      const patchedDraftShape = drafts.every((draft) => draft.version === 2
        && (JSON.parse(draft.payloadJson) as { items?: unknown[] }).items?.length === 2);
      const mixedDraftShape = drafts.filter((draft) => draft.version === 2
        && (JSON.parse(draft.payloadJson) as { items?: unknown[] }).items?.length === 2).length === 1
        && drafts.filter((draft) => draft.version === 1
          && (JSON.parse(draft.payloadJson) as { items?: unknown[] }).items?.length === 1).length === 2;
      assert(initialDraftShape || patchedDraftShape || mixedDraftShape,
        'draft-recovery candidates are neither the exact initial, partially human-corrected, nor fully corrected fixture');
      if (mixedDraftShape) {
        const corrected = drafts.find((draft) => draft.version === 2)!;
        assert(inquiries.find((inquiry) => inquiry.id === corrected.inquiryId)?.supplierId === 's001',
          'partial human-draft recovery found an unexpected supplier correction order');
      }
      for (const draft of drafts) {
        const email = emails.find((candidate) => candidate.id === draft.emailId);
        const inquiry = inquiries.find((candidate) => candidate.id === draft.inquiryId);
        assert(email && inquiry, 'AI draft is missing its original email or inquiry');
        const expectedOffers = offersFromPersistedReply(email.body, inquiry.items);
        const payload = JSON.parse(draft.payloadJson) as { items: Array<JsonRecord> };
        if (draft.version === 1) {
          assert(payload.items.length === 1 && payload.items[0].evidenceText === expectedOffers[1].evidenceText,
            'initial AI draft does not match the known fixture first-line parsing issue');
        } else {
          assert(payload.items.length === expectedOffers.length && new Set(payload.items.map((item) => item.inquiryItemId)).size === inquiry.items.length,
            'human-patched draft does not bind every distinct inquiry item');
          const supplierId = inquiries.find((candidate) => candidate.id === draft.inquiryId)?.supplierId;
          for (const [index, offer] of expectedOffers.entries()) {
            const demand = inquiry.items.find((candidate) => candidate.rfqLineId === offer.lineId);
            const item = payload.items.find((candidate) => candidate.inquiryItemId === demand?.id);
            assert(item && demand && item.inquiryItemId === demand.id && item.partNumber === offer.partNumber
              && Number(item.quantity) === offer.quantity && Number(item.unitPrice) === offer.unitPrice,
            'human-patched draft does not preserve the original offer evidence and explicit line binding');
            assert(item.evidenceText === offer.evidenceText
              || (draft.version === 2 && supplierId === 's001' && index === 0 && !item.evidenceText),
            'human-patched draft contains unexpected or mismatched offer evidence');
          }
        }
      }

      recoveryState = {
        stage: patchedDraftShape ? 'drafts-patched' : mixedDraftShape ? 'drafts-partially-patched' : 'drafts-ready',
        rfqId: rfq.id,
        emailAccountId: accounts[0].id,
        modelId: fixtureModels[0]!.id,
      };
      resultArtifact.initialModelFixtureIssue = {
        candidateCountPerDraft: 1,
        expectedCandidatesPerDraft: 2,
        cause: 'first reply line was prefixed by the prompt template label and was skipped by the original fixture regex',
      };
      resultArtifact.initialModelDraftCandidateCounts = SUPPLIER_FIXTURES.map((supplier) => ({ supplierId: supplier.id, candidateCount: 1 }));
      if (patchedDraftShape || mixedDraftShape) {
        resultArtifact.humanDraftCorrection = { correctedSuppliers: drafts.filter((draft) => draft.version === 2).map((draft) => inquiries.find((inquiry) => inquiry.id === draft.inquiryId)?.supplierId), itemsPerDraft: 2, explicitlyBoundDistinctInquiryItems: true };
      }
      console.warn(JSON.stringify({ recovery: patchedDraftShape ? 'exact-human-patched-ai-draft-fixture' : mixedDraftShape ? 'exact-partially-human-patched-ai-draft-fixture' : 'exact-completed-ai-draft-fixture', rfqId: recoveryState.rfqId, draftCount: drafts.length }));
    }

    const [customer, manager, salesUser, suppliers] = await Promise.all([
      prisma.customer.findUnique({ where: { id: CUSTOMER_ID }, select: { id: true, status: true } }),
      prisma.user.findUnique({ where: { id: MANAGER_ID }, select: { id: true, email: true, name: true, role: true, department: true, avatar: true, isActive: true } }),
      prisma.user.findUnique({ where: { id: SALES_USER_ID }, select: { id: true, email: true, name: true, role: true, department: true, avatar: true, isActive: true } }),
      prisma.supplier.findMany({
        where: { id: { in: SUPPLIER_FIXTURES.map((supplier) => supplier.id) } },
        select: { id: true, name: true, email: true },
      }),
    ]);
    assert(customer?.status === 'ACTIVE', `expected active seeded customer ${CUSTOMER_ID}`);
    assert(manager?.isActive && manager.role.toLowerCase() === 'manager', `expected active seeded manager ${MANAGER_ID}`);
    assert(salesUser?.isActive && salesUser.role.toLowerCase() === 'sales', `expected active seeded sales user ${SALES_USER_ID}`);
    assert(suppliers.length === SUPPLIER_FIXTURES.length, 'expected all three seeded suppliers');
    for (const expected of SUPPLIER_FIXTURES) {
      const actual = suppliers.find((supplier) => supplier.id === expected.id);
      assert(actual?.name === expected.name, `seeded supplier ${expected.id} does not match the isolated fixture`);
      assert(actual.email === (recoveryState ? expected.email : expected.expectedSeedEmail),
        `supplier ${expected.id} has an unexpected email; refusing to overwrite it`);
    }

    const actor = {
      id: salesUser.id,
      email: salesUser.email,
      name: salesUser.name,
      role: salesUser.role,
      department: salesUser.department,
      avatar: salesUser.avatar,
    };
    const modelActor = {
      id: manager.id,
      email: manager.email,
      name: manager.name,
      role: manager.role,
      department: manager.department,
      avatar: manager.avatar,
    };
    resultArtifact.testLogin = { email: salesUser.email, userId: salesUser.id, role: salesUser.role };

    if (!recoveryState || recoveryState.stage === 'send-queued') {
      await assertMailFixtureIsEmpty(fetchMailboxMessages);
    }
    const localBuyerAccount = fixtureAccount(BUYER_EMAIL);
    assert(await testSmtpConnection(localBuyerAccount), 'GreenMail SMTP authentication probe failed');
    assert(await testImapConnection(localBuyerAccount), 'GreenMail IMAP connection probe failed');

    if (!recoveryState) {
      for (const expected of SUPPLIER_FIXTURES) {
        const updated = await prisma.supplier.updateMany({
          where: { id: expected.id, email: expected.expectedSeedEmail },
          data: { email: expected.email },
        });
        assert(updated.count === 1, `supplier ${expected.id} email could not be rebound to the loopback GreenMail mailbox`);
      }
    }

    const buyerAccount = recoveryState
      ? await prisma.emailAccount.update({
        where: { id: recoveryState.emailAccountId },
        // The interrupted process generated an ephemeral encryption key. Re-key
        // only this already-validated fixture account for the resumed run.
        data: { authCode: encrypt(MAIL_PASSWORD) },
      })
      : await prisma.emailAccount.create({
        data: {
          email: BUYER_EMAIL,
          displayName: 'Sourcing Workflow Acceptance Buyer',
          imapServer: IMAP_HOST,
          imapPort: String(IMAP_PORT),
          smtpServer: SMTP_HOST,
          smtpPort: String(SMTP_PORT),
          authCode: encrypt(MAIL_PASSWORD),
          isActive: true,
          isDefault: true,
          accountType: 'custom',
          syncInterval: 0,
        },
      });

    fixture = await startModelFixture();
    const app = createAuthenticatedApp(actor, modelActor, {
      rfqs: rfqsRouter,
      inquiries: inquiriesRouter,
      tasks: sourcingAiTasksRouter,
      drafts: supplierQuoteDraftsRouter,
      supplierQuotes: supplierQuotesRouter,
      models: modelsRouter,
    }, errorHandler);
    routeServer = await startExpressServer(app);

    await ensureBuiltinAgents();
    await ensureBuiltinAgents();
    const extractionAgent = await prisma.aIAgent.findUnique({
      where: { builtinKey: 'supplier_quote_extraction' },
      select: { id: true, publishedVersion: true },
    });
    assert(extractionAgent?.publishedVersion === 1, 'supplier quote extraction agent was not initialized at published version 1');
    assert(await prisma.aIAgentVersion.count({ where: { agentId: extractionAgent.id } }) === 1,
      'supplier quote extraction initialization did not remain idempotent');

    const modelResponse = recoveryState
      ? await callRoute(routeServer.baseUrl, 'patch', `/api/models/${encodeURIComponent(recoveryState.modelId)}`, {
        baseUrl: fixture.baseUrl,
        apiKey: MODEL_SECRET,
        isActive: true,
        isDefault: true,
      })
      : await callRoute(routeServer.baseUrl, 'post', '/api/models', {
        name: `Sourcing workflow local fixture ${crypto.randomUUID()}`,
        provider: 'custom',
        modelId: 'sourcing-fixture-model',
        baseUrl: fixture.baseUrl,
        apiKey: MODEL_SECRET,
        isActive: true,
        isDefault: true,
        config: { temperature: 0, maxTokens: 2048 },
      }, idempotencyKey('model'));
    const modelData = successData(modelResponse, recoveryState ? 'local model fixture rebinding' : 'local model fixture creation');
    assert(modelData.hasApiKey === true, 'local model fixture did not retain its configured test key');
    const fixtureModelId = String(modelData.id);
    assert((await prisma.aIModel.findUnique({ where: { id: fixtureModelId } }))?.baseUrl === fixture.baseUrl,
      'local model fixture base URL did not persist');

    const date = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
    const requiredDate = date.toISOString().slice(0, 10);
    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rfqId = recoveryState
      ? recoveryState.rfqId
      : String(successData(await callRoute(routeServer.baseUrl, 'post', '/api/rfqs', {
        customerId: CUSTOMER_ID,
        urgency: 'STANDARD',
        responseDeadline: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        notes: ACCEPTANCE_RFQ_NOTES,
        lines: [
          { partNumber: 'SWF-DUPLICATE-001', quantity: 2, uom: 'EA', conditionCode: 'NE', certificateRequired: false, requiredDate },
          { partNumber: 'SWF-DUPLICATE-001', quantity: 3, uom: 'EA', conditionCode: 'NE', certificateRequired: false, requiredDate },
          { partNumber: 'SWF-THIRD-003', quantity: 1, uom: 'EA', conditionCode: 'NE', certificateRequired: false, requiredDate },
        ],
      }, idempotencyKey('rfq')), 'three-line RFQ creation').id);
    resultArtifact.rfqId = rfqId;
    const lines = await prisma.rfqLine.findMany({
      where: { rfqId },
      orderBy: { lineNo: 'asc' },
      select: { id: true, lineNo: true, partNumber: true, quantity: true, uom: true, requiredDate: true },
    }) as RfqLine[];
    assert(lines.length === 3, 'RFQ did not persist exactly three demand lines');
    assert(lines[0].partNumber === lines[1].partNumber && lines[0].id !== lines[1].id,
      'repeated part number was not preserved as two distinct demand lines');
    assert(new Set(lines.map((line) => line.id)).size === 3, 'RFQ line IDs are not unique');

    const scopeBySupplier: Record<string, number[]> = {
      s001: [1, 2],
      s002: [2, 3],
      s003: [1, 3],
    };
    const supplierInquiryIds: string[] = [];
    for (const supplier of SUPPLIER_FIXTURES) {
      const selectedLines = lines.filter((line) => scopeBySupplier[supplier.id].includes(line.lineNo));
      assert(selectedLines.length === 2, `supplier ${supplier.id} does not have its independent two-line scope`);
      let inquiryId: string;
      if (recoveryState?.stage === 'send-queued' && supplier.id === 's001') {
        inquiryId = recoveryState.inquiryId!;
      } else if (recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched') {
        const existing = await prisma.inquiry.findFirst({ where: { rfqId, supplierId: supplier.id }, select: { id: true } });
        assert(existing, `draft recovery is missing inquiry for ${supplier.id}`);
        inquiryId = existing.id;
      } else {
        const inquiryResponse = await callRoute(routeServer.baseUrl, 'post', '/api/inquiries', {
          rfqId,
          supplierIds: [supplier.id],
          lineIds: selectedLines.map((line) => line.id),
        }, idempotencyKey(`inquiry-${supplier.id}`));
        assertStatus(inquiryResponse, 201, `inquiry creation for ${supplier.id}`);
        const inquiryRows = successData(inquiryResponse, `inquiry creation for ${supplier.id}`);
        assert(Array.isArray(inquiryRows) && inquiryRows.length === 1, `supplier ${supplier.id} did not receive exactly one inquiry`);
        inquiryId = String((inquiryRows[0] as JsonRecord).id);
      }
      supplierInquiryIds.push(inquiryId);
      const inquiryItems = await prisma.inquiryItem.findMany({
        where: { inquiryId },
        orderBy: { lineNo: 'asc' },
        select: { id: true, lineNo: true, rfqLineId: true, partNumber: true, quantity: true },
      });
      assert(inquiryItems.length === 2, `inquiry ${inquiryId} did not retain the supplier-specific line range`);
      const expectedIds = selectedLines.map((line) => line.id).sort();
      assert(inquiryItems.map((item) => item.rfqLineId).sort().join(',') === expectedIds.join(','),
        `inquiry ${inquiryId} is bound to the wrong RFQ lines`);

      let inboundEmailId: string | undefined;
      let recoveredTaskId: string | undefined;
      let recoveredDraftId: string | undefined;
      let offers = offersForSupplier(supplier.id, selectedLines);
      for (const offer of offers) offer.evidenceText = replyBody([offer], validUntil);
      if (recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched') {
        const [inbound, task] = await Promise.all([
          prisma.email.findFirst({ where: { accountId: buyerAccount.id, from: { contains: supplier.email } }, select: { id: true, body: true } }),
          prisma.sourcingAiTask.findFirst({ where: { inquiryId }, select: { id: true, status: true, draftId: true } }),
        ]);
        assert(inbound && task?.status === 'COMPLETED' && task.draftId, `draft recovery lacks a completed task or reply for ${supplier.id}`);
        inboundEmailId = inbound.id;
        recoveredTaskId = task.id;
        recoveredDraftId = task.draftId;
        offers = offersFromPersistedReply(inbound.body, inquiryItems);
      }
      if (recoveryState?.stage === 'send-queued' && supplier.id === 's001') {
        const statusResponse = await callRoute(routeServer.baseUrl, 'get', `/api/inquiries/${encodeURIComponent(inquiryId)}`);
        const statusData = successData(statusResponse, `recovered send status for ${supplier.id}`);
        assert(statusData.status === 'queued' && statusData.deliveryStatus === 'queued',
          `inquiry ${inquiryId} recovered with unexpected route status: ${JSON.stringify(statusData)}`);
        resultArtifact.recoveredSendResponse = { status: statusData.status, deliveryStatus: statusData.deliveryStatus };
      } else if (recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched') {
        const statusResponse = await callRoute(routeServer.baseUrl, 'get', `/api/inquiries/${encodeURIComponent(inquiryId)}`);
        const statusData = successData(statusResponse, `recovered sent status for ${supplier.id}`);
        assert(statusData.status === 'sent' && statusData.deliveryStatus === 'smtp_accepted',
          `inquiry ${inquiryId} recovered with unexpected sent route status: ${JSON.stringify(statusData)}`);
      } else {
        const sendResponse = await callRoute(routeServer.baseUrl, 'post', `/api/inquiries/${encodeURIComponent(inquiryId)}/send`, {}, idempotencyKey(`send-${supplier.id}`));
        assertStatus(sendResponse, 202, `inquiry send enqueue for ${supplier.id}`);
        const sendData = successData(sendResponse, `inquiry send enqueue for ${supplier.id}`);
        assert(sendData.status === 'queued' && sendData.deliveryStatus === 'queued',
          `inquiry ${inquiryId} did not return the queued route status: ${JSON.stringify(sendData)}`);
      }

      const outbound = await prisma.outboundEmail.findFirst({
        where: { inquiryId, purpose: 'INQUIRY_SEND' },
        orderBy: { createdAt: 'desc' },
      });
      const isDraftRecovery = recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched';
      const expectedOutboundStatus = isDraftRecovery ? 'SENT' : 'PENDING';
      assert(outbound?.status === expectedOutboundStatus, `inquiry ${inquiryId} outbound email is not ${expectedOutboundStatus}`);
      assert(outbound.toEmail === supplier.email, `inquiry ${inquiryId} recipient is not ${supplier.email}`);
      assert(outbound.textBody.includes('SWF-'), `inquiry ${inquiryId} did not contain a request line`);
      const event = await prisma.outboxEvent.findFirst({
        where: { channel: 'EMAIL', aggregateType: 'INQUIRY', aggregateId: inquiryId },
        orderBy: { createdAt: 'desc' },
      });
      const expectedEventStatus = isDraftRecovery ? 'DELIVERED' : 'PENDING';
      assert(event?.status === expectedEventStatus, `inquiry ${inquiryId} email outbox event is not ${expectedEventStatus}`);
      supplierRuns.push({
        supplierId: supplier.id,
        supplierEmail: supplier.email,
        inquiryId,
        outboundEmailId: outbound.id,
        outboxEventId: event.id,
        providerMessageId: outbound.providerMessageId ?? '',
        offers,
        inboundEmailId,
        taskId: recoveredTaskId,
        draftId: recoveredDraftId,
      });
      resultArtifact.inquiryIds = supplierRuns.map((run) => ({ supplierId: run.supplierId, inquiryId: run.inquiryId }));
    }
    resultArtifact.inquiryIds = supplierRuns.map((run) => ({ supplierId: run.supplierId, inquiryId: run.inquiryId }));

    for (const run of supplierRuns) {
      const processed = recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched'
        ? false
        : await processOutboxEvent(run.outboxEventId, `sourcing-integration-${run.supplierId}`, {
          channels: [OutboxChannel.EMAIL],
        });
      if (!processed && recoveryState?.stage !== 'drafts-ready' && recoveryState?.stage !== 'drafts-partially-patched' && recoveryState?.stage !== 'drafts-patched') {
        await waitFor(`SMTP delivery for ${run.supplierEmail}`, async () => {
          const current = await prisma.outboundEmail.findUnique({ where: { id: run.outboundEmailId }, select: { status: true } });
          return current?.status ?? 'MISSING';
        }, (status) => status === 'SENT');
      }
      const [outbound, event] = await Promise.all([
        prisma.outboundEmail.findUnique({ where: { id: run.outboundEmailId } }),
        prisma.outboxEvent.findUnique({ where: { id: run.outboxEventId } }),
      ]);
      assert(outbound?.status === 'SENT', `SMTP worker did not mark ${run.supplierEmail} email SENT`);
      assert(event?.status === 'DELIVERED', `SMTP outbox event for ${run.supplierEmail} was not delivered`);
      assert(outbound.providerMessageId, `SMTP worker did not persist Message-ID for ${run.supplierEmail}`);
      run.providerMessageId = outbound.providerMessageId;
    }
    assert(new Set(supplierRuns.map((run) => run.providerMessageId)).size === 3,
      'three independently addressed supplier inquiries did not receive distinct Message-IDs');
    assert(supplierRuns.every((run) => normalizeMessageId(run.providerMessageId)?.endsWith(`@${MAILBOX_DOMAIN}`)),
      'outbound SMTP Message-ID escaped the sourcing.test fixture domain');

    for (const run of supplierRuns) {
      const inbox = await fetchMailboxMessages(fixtureAccount(run.supplierEmail), { afterUid: 0, limit: 50 });
      assert(inbox.emails.length === 1, `${run.supplierEmail} inbox did not receive exactly its own inquiry`);
      const message = inbox.emails[0];
      assert(normalizeMessageId(message.messageId) === normalizeMessageId(run.providerMessageId),
        `${run.supplierEmail} inbox Message-ID does not match the outbox record`);
      assert(normalizeEmail(message.from) === BUYER_EMAIL, `${run.supplierEmail} inbox shows the wrong sender`);
      assert(message.body.includes('询价单号') && message.body.includes(run.offers[0].partNumber),
        `${run.supplierEmail} received content does not match its inquiry scope`);
      const receivedRequestLines = [...message.body.matchAll(/^\d+\.\s+件号\s+([^；\s]+)；数量\s+([0-9]+)/gm)];
      assert(receivedRequestLines.length === run.offers.length,
        `${run.supplierEmail} received a request with the wrong number of demand lines`);
      assert(receivedRequestLines.map((match) => match[1]).sort().join(',')
        === run.offers.map((offer) => offer.partNumber).sort().join(','),
      `${run.supplierEmail} received content outside its independent inquiry scope`);
    }

    // GreenMail's local fixture accepts authenticated SMTP for seeded user
    // addresses. Each supplier sends a real message into buyer@sourcing.test.
    if (recoveryState?.stage !== 'drafts-ready' && recoveryState?.stage !== 'drafts-partially-patched' && recoveryState?.stage !== 'drafts-patched') {
      for (const run of supplierRuns) {
        const providerMessageId = run.providerMessageId;
        const body = replyBody(run.offers, validUntil);
        const replyMessageId = `<supplier-reply-${crypto.randomUUID()}@${MAILBOX_DOMAIN}>`;
        const supplierTransport = createTransport({
          host: SMTP_HOST,
          port: SMTP_PORT,
          secure: false,
          auth: { user: run.supplierEmail, pass: MAIL_PASSWORD },
        });
        try {
          const sent = await supplierTransport.sendMail({
            from: `${run.supplierEmail}`,
            to: BUYER_EMAIL,
            subject: `Re: sourcing acceptance ${run.inquiryId}`,
            text: body,
            messageId: replyMessageId,
            inReplyTo: providerMessageId,
            references: [providerMessageId],
          });
          assert(normalizeMessageId(sent.messageId) === normalizeMessageId(replyMessageId),
            `supplier ${run.supplierId} reply Message-ID was not accepted as requested`);
        } finally {
          supplierTransport.close();
        }
      }
    }

    if (recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched') {
      assert(await prisma.email.count({ where: { accountId: buyerAccount.id } }) === 3,
        'draft recovery no longer contains exactly the three original IMAP replies');
      resultArtifact.recoveredImapEvidence = { persistedReplies: 3, cursorLastUid: 3, firstSyncSavedCount: 3 };
    } else {
      const firstSync = await syncEmailAccount(buyerAccount.id, {
        force: true,
        batchSize: 50,
        workerId: 'sourcing-workflow-acceptance-first-sync',
      });
      assert(firstSync.claimed && firstSync.savedCount === 3 && firstSync.fetchedCount === 3,
        `IMAP sync did not ingest three replies (saved=${firstSync.savedCount}, fetched=${firstSync.fetchedCount})`);
      resultArtifact.firstImapSync = { fetchedCount: firstSync.fetchedCount, savedCount: firstSync.savedCount };
    }
    const syncedEmails = await prisma.email.findMany({
      where: { accountId: buyerAccount.id },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, from: true, subject: true, body: true, messageId: true, inReplyTo: true, references: true, threadMatchStatus: true, threadMatchReason: true },
    });
    assert(syncedEmails.length === 3, 'first IMAP sync did not persist exactly three supplier replies');
    for (const run of supplierRuns) {
      const message = syncedEmails.find((email) => normalizeEmail(email.from) === run.supplierEmail);
      assert(message, `IMAP did not persist reply from ${run.supplierEmail}`);
      assert(normalizeMessageId(message.inReplyTo) === normalizeMessageId(run.providerMessageId),
        `reply from ${run.supplierEmail} lost its In-Reply-To reference`);
      const references = message.references ? JSON.parse(message.references) as string[] : [];
      assert(references.some((reference) => normalizeMessageId(reference) === normalizeMessageId(run.providerMessageId)),
        `reply from ${run.supplierEmail} lost its References header`);
      assert(message.threadMatchStatus === 'MATCHED' && message.threadMatchReason === 'MESSAGE_ID_AND_SUPPLIER_EMAIL_MATCH',
        `reply from ${run.supplierEmail} did not auto-associate by Message-ID and supplier address`);
      const link = await prisma.inquiryEmailLink.findUnique({
        where: { emailId_inquiryId: { emailId: message.id, inquiryId: run.inquiryId } },
        select: { confirmationStatus: true, method: true },
      });
      assert(link?.confirmationStatus === 'CONFIRMED' && link.method === 'AUTO_MESSAGE_ID',
        `reply from ${run.supplierEmail} is not linked to its own inquiry`);
      run.inboundEmailId = message.id;
    }
    resultArtifact.emailIds = supplierRuns.map((run) => ({ supplierId: run.supplierId, emailId: run.inboundEmailId }));

    const secondSync = await syncEmailAccount(buyerAccount.id, {
      force: true,
      batchSize: 50,
      workerId: 'sourcing-workflow-acceptance-repeat-sync',
    });
    assert(secondSync.savedCount === 0 && secondSync.fetchedCount === 0,
      'second IMAP sync duplicated an already-ingested supplier reply');
    assert(await prisma.email.count({ where: { accountId: buyerAccount.id } }) === 3,
      'email row count changed after the duplicate IMAP sync');

    const taskIds: string[] = [];
    if (recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched') {
      for (const run of supplierRuns) {
        assert(run.taskId && run.draftId && run.inboundEmailId, `draft recovery is missing task artifacts for ${run.supplierId}`);
        taskIds.push(run.taskId);
      }
      resultArtifact.correctedFixtureValidation = [];
      const extractionAgent = await prisma.aIAgent.findUniqueOrThrow({ where: { builtinKey: 'supplier_quote_extraction' } });
      const extractionVersion = await prisma.aIAgentVersion.findUniqueOrThrow({
        where: { agentId_version: { agentId: extractionAgent.id, version: extractionAgent.publishedVersion! } },
      });
      for (const run of supplierRuns) {
        const [email, inquiry] = await Promise.all([
          prisma.email.findUniqueOrThrow({ where: { id: run.inboundEmailId! }, select: { subject: true, body: true } }),
          prisma.inquiry.findUniqueOrThrow({ where: { id: run.inquiryId }, include: { items: { orderBy: { lineNo: 'asc' } } } }),
        ]);
        const messages = renderAgentPrompts(JSON.parse(extractionVersion.prompts), {
          subject: email.subject,
          body: email.body,
          inquiryContext: {
            inquiryId: inquiry.id,
            inquiryNumber: inquiry.inquiryNumber,
            items: inquiry.items.map((item) => ({ inquiryItemId: item.id, partNumber: item.partNumber, quantity: item.quantity })),
          },
        });
        const fixtureResponse = await callLocalFixture(fixture!, messages);
        const candidates = fixtureResponse.items as Array<JsonRecord> | undefined;
        assert(candidates?.length === run.offers.length,
          `corrected local fixture returned ${candidates?.length ?? 0} candidates for ${run.supplierId}, expected ${run.offers.length}`);
        for (const offer of run.offers) {
          const candidate = candidates.find((item) => item.evidenceText === offer.evidenceText);
          assert(candidate && candidate.partNumber === offer.partNumber && Number(candidate.quantity) === offer.quantity
            && Number(candidate.unitPrice) === offer.unitPrice && Number(candidate.leadTimeDays) === offer.leadTimeDays,
          `corrected local fixture did not preserve the complete source candidate for ${run.supplierId}`);
        }
        (resultArtifact.correctedFixtureValidation as Array<JsonRecord>).push({ supplierId: run.supplierId, candidateCount: candidates.length });
      }
    } else {
      for (const run of supplierRuns) {
        assert(run.inboundEmailId, `supplier ${run.supplierId} reply has no inbound email ID`);
        const response = await callRoute(routeServer.baseUrl, 'post', '/api/sourcing-ai-tasks', {
          type: SUPPLIER_QUOTE_EXTRACTION_TASK,
          emailId: run.inboundEmailId,
          inquiryId: run.inquiryId,
          idempotencyKey: idempotencyKey(`ai-${run.supplierId}`),
        });
        assertStatus(response, 201, `AI task creation for ${run.supplierId}`);
        const data = successData(response, `AI task creation for ${run.supplierId}`);
        assert(data.status === 'PENDING', `AI task for ${run.supplierId} did not persist before processing`);
        taskIds.push(String(data.id));
      }
      // Simulate a process dying after claiming the first task. A fresh Node
      // process must recover its expired persisted lease and produce each draft
      // exactly once; the parent does not execute these tasks directly.
      const expiredClaimAt = new Date(Date.now() - 60_000);
      await prisma.sourcingAiTask.update({
        where: { id: taskIds[0] },
        data: { status: 'RUNNING', startedAt: expiredClaimAt },
      });
      const restartedWorker = spawn(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e',
        "import { processPendingSourcingAiTasks } from './src/lib/sourcingAiTaskService.ts'; import prisma from './src/lib/prisma.ts'; const batch = await processPendingSourcingAiTasks(10, 1000); console.log('RECOVERY_BATCH=' + JSON.stringify(batch)); await prisma.$disconnect();",
      ], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let restartedWorkerOutput = '';
      restartedWorker.stdout?.on('data', (chunk: Buffer) => { restartedWorkerOutput += chunk.toString(); });
      restartedWorker.stderr?.resume();
      const restartedWorkerExitCode = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          restartedWorker.kill();
          reject(new Error('fresh AI worker process timed out'));
        }, 60_000);
        restartedWorker.once('error', (error) => { clearTimeout(timeout); reject(error); });
        restartedWorker.once('close', (code) => { clearTimeout(timeout); resolve(code); });
      });
      assert(restartedWorkerExitCode === 0 && restartedWorkerOutput.includes('RECOVERY_BATCH={"recovered":1,"processed":3}'),
        'fresh AI worker process did not recover one expired claim and complete all three tasks');
      const taskBatch = await processPendingSourcingAiTasks(10);
      assert(taskBatch.processed === 0, `second AI worker pass processed ${taskBatch.processed} tasks, expected none`);
      resultArtifact.restartedAiWorkerRecovery = { recoveredLeases: 1, completedTasks: 3, secondPassProcessed: 0 };
    }

    for (const [index, run] of supplierRuns.entries()) {
      const taskId = taskIds[index];
      const completedTask = await waitFor(`AI task for ${run.supplierId}`, async () => {
        const task = await prisma.sourcingAiTask.findUnique({ where: { id: taskId }, select: { status: true, draftId: true } });
        return task ?? { status: 'MISSING', draftId: null };
      }, (task) => task.status === 'COMPLETED');
      assert(completedTask.draftId, `AI task for ${run.supplierId} completed without a quote draft`);
      run.draftId = completedTask.draftId;

      const draftResponse = await callRoute(routeServer.baseUrl, 'get', `/api/supplier-quote-drafts/${encodeURIComponent(run.draftId)}`);
      const draftData = successData(draftResponse, `AI draft read for ${run.supplierId}`);
      assert(draftData.status === 'DRAFT' && draftData.aiModel === 'sourcing-fixture-model',
        `AI task for ${run.supplierId} did not create a fixture-backed editable draft`);
      assert(draftData.aiPromptVersion === '1', `AI draft for ${run.supplierId} lost prompt version attribution`);
      const draftPayload = draftData.payload as { items?: Array<JsonRecord> };
      const draftItems = draftPayload.items;
      assert(Array.isArray(draftItems), `AI draft for ${run.supplierId} has no item list`);
      const retainedInitialAiDraft = (recoveryState?.stage === 'drafts-ready' || recoveryState?.stage === 'drafts-partially-patched')
        && Number(draftData.version) === 1;
      const retainedHumanEdit = (recoveryState?.stage === 'drafts-partially-patched' || recoveryState?.stage === 'drafts-patched')
        && Number(draftData.version) === 2 && draftItems.length === run.offers.length
        && run.offers.every((offer) => draftItems.some((item) => item.evidenceText === offer.evidenceText));
      if (retainedInitialAiDraft) {
        assert(draftItems.length === 1 && run.offers.length === 2
          && draftItems[0].evidenceText === run.offers[1].evidenceText,
        `retained initial AI draft for ${run.supplierId} differs from the documented first-line fixture issue`);
      } else if (retainedHumanEdit) {
        assert(draftItems.length === run.offers.length,
          `retained human-patched draft for ${run.supplierId} no longer has two complete offer rows`);
      } else {
        assert(draftItems.length === run.offers.length,
          `AI draft for ${run.supplierId} is incomplete`);
      }
      const inquiryItems = await prisma.inquiryItem.findMany({
        where: { inquiryId: run.inquiryId },
        orderBy: { lineNo: 'asc' },
        select: { id: true, rfqLineId: true, partNumber: true, quantity: true },
      });
      assert(inquiryItems.length === run.offers.length, `inquiry ${run.inquiryId} item count does not match the draft`);
      const payloadItems = run.offers.map((offer) => {
        const original = draftItems.find((candidate) => candidate.evidenceText === offer.evidenceText);
        const demand = inquiryItems.find((candidate) => candidate.rfqLineId === offer.lineId);
        assert(demand && demand.partNumber === offer.partNumber, `supplier ${run.supplierId} quote evidence maps to the wrong demand line`);
        assert(demand.quantity === offer.quantity, `supplier ${run.supplierId} offer quantity does not match its bound demand line`);
        const validUntilFromEvidence = offer.evidenceText.match(/valid until (\d{4}-\d{2}-\d{2})\.$/)?.[1];
        assert(validUntilFromEvidence, `supplier ${run.supplierId} offer evidence has no explicit validity date`);
        return {
          ...(original ?? {}),
          itemKey: typeof original?.itemKey === 'string' ? original.itemKey : crypto.randomUUID(),
          inquiryItemId: demand.id,
          partNumber: demand.partNumber,
          quantity: offer.quantity,
          quantityUnit: 'EA',
          unitPrice: offer.unitPrice,
          currency: 'USD',
          leadTimeDays: offer.leadTimeDays,
          validUntil: validUntilFromEvidence,
          evidenceText: offer.evidenceText,
          condition: 'NE',
          certificate: 'NOT_REQUIRED',
          taxIncluded: false,
          freightIncluded: false,
          incoterm: 'EXW',
        };
      });
      const patchedDraft = retainedHumanEdit
        ? draftData
        : successData(await callRoute(routeServer.baseUrl, 'patch', `/api/supplier-quote-drafts/${encodeURIComponent(run.draftId)}`, {
          expectedVersion: Number(draftData.version),
          payload: { items: payloadItems },
        }), `human draft repair for ${run.supplierId}`);
      if (retainedHumanEdit) {
        assert(payloadItems.every((expected) => draftItems.some((actual) => actual.itemKey === expected.itemKey
          && actual.inquiryItemId === expected.inquiryItemId && actual.evidenceText === expected.evidenceText
          && Number(actual.unitPrice) === Number(expected.unitPrice))),
        `retained human edits for ${run.supplierId} no longer match the explicit line-bound candidates`);
      } else {
        assert(Number(patchedDraft.version) === Number(draftData.version) + 1,
          `human edits did not increment draft version for ${run.supplierId}`);
      }
      assert(payloadItems.length === run.offers.length
        && new Set(payloadItems.map((item) => item.inquiryItemId)).size === inquiryItems.length,
      `human edits did not explicitly bind every distinct inquiry line for ${run.supplierId}`);

      const confirmPath = `/api/sourcing-ai-tasks/${encodeURIComponent(taskId)}/confirm-draft`;
      const firstConfirm = await callRoute(routeServer.baseUrl, 'post', confirmPath, { expectedVersion: Number(patchedDraft.version) });
      const firstConfirmData = successData(firstConfirm, `human quote confirmation for ${run.supplierId}`);
      assert(firstConfirmData.status === 'CONFIRMED' && firstConfirmData.reused === false,
        `first confirmation for ${run.supplierId} did not create formal supplier quotes`);
      const firstQuoteIds = (firstConfirmData.supplierQuoteIds as string[]) || [];
      assert(firstQuoteIds.length === run.offers.length, `confirmation for ${run.supplierId} created an incomplete formal quote set`);
      const quoteCountAfterFirstConfirm = await prisma.supplierQuote.count();
      const secondConfirm = await callRoute(routeServer.baseUrl, 'post', confirmPath, { expectedVersion: Number(patchedDraft.version) });
      const secondConfirmData = successData(secondConfirm, `repeated quote confirmation for ${run.supplierId}`);
      assert(secondConfirmData.reused === true, `repeated confirmation for ${run.supplierId} did not reuse existing quote IDs`);
      assert(JSON.stringify(secondConfirmData.supplierQuoteIds) === JSON.stringify(firstQuoteIds),
        `repeated confirmation for ${run.supplierId} returned different formal quote IDs`);
      assert(await prisma.supplierQuote.count() === quoteCountAfterFirstConfirm,
        `repeated confirmation for ${run.supplierId} duplicated a formal supplier quote`);
      run.quoteIds = firstQuoteIds;
    }
    resultArtifact.draftIds = supplierRuns.map((run) => ({ supplierId: run.supplierId, draftId: run.draftId }));
    resultArtifact.supplierQuoteIds = supplierRuns.flatMap((run) => (run.quoteIds ?? []).map((quoteId) => ({ supplierId: run.supplierId, quoteId })));
    const timelineData = successData(await callRoute(routeServer.baseUrl, 'get', `/api/rfqs/${encodeURIComponent(rfqId)}/sourcing-timeline`),
      'sourcing timeline after human quote confirmation');
    const timelineEvents = timelineData.events as Array<JsonRecord>;
    const humanSendConfirmations = timelineEvents.filter((event) => event.type === 'INQUIRY_SEND_CONFIRMED');
    const humanRevisions = timelineEvents.filter((event) => event.type === 'QUOTE_DRAFT_REVISED');
    const aiDraftEvents = timelineEvents.filter((event) => event.type === 'QUOTE_DRAFT'
      && typeof event.summary === 'string' && event.summary.includes('AI 提出'));
    if (!recoveryState) {
      assert(humanSendConfirmations.length === SUPPLIER_FIXTURES.length
        && humanSendConfirmations.every((event) => (event.actor as JsonRecord | null)?.id === SALES_USER_ID && event.status === 'QUEUED'),
      'timeline did not preserve each human send approval separately from delivery results');
      assert(humanRevisions.length === SUPPLIER_FIXTURES.length
        && humanRevisions.every((event) => (event.actor as JsonRecord | null)?.id === SALES_USER_ID && event.status === 'SAVED'),
      'timeline did not preserve every human draft revision with its real actor');
      assert(aiDraftEvents.length === SUPPLIER_FIXTURES.length,
      'timeline did not distinguish the three persisted AI quote suggestions');
      assert(aiDraftEvents.every((event) => {
        const snapshot = event.originalAiCandidates as JsonRecord | null;
        const items = snapshot?.items;
        return snapshot?.available === true && snapshot.candidateCount === 2
          && Array.isArray(items) && items.length === 2
          && !JSON.stringify(snapshot).includes('evidenceText');
      }), 'timeline lost the original AI candidate details after human draft edits');
    }
    resultArtifact.timelineHumanSendConfirmationCount = humanSendConfirmations.length;
    resultArtifact.timelineHumanDraftRevisionCount = humanRevisions.length;
    resultArtifact.timelineOriginalAiDraftCount = aiDraftEvents.length;

    const expectedWinners: Array<{ lineNo: number; supplierId: string; unitPrice: number }> = [
      { lineNo: 1, supplierId: 's003', unitPrice: 105 },
      { lineNo: 2, supplierId: 's002', unitPrice: 195 },
      { lineNo: 3, supplierId: 's003', unitPrice: 70 },
    ];
    const selectedWinners: Array<{ rfqLineId: string; lineNo: number; partNumber: string; supplierId: string; quoteId: string; unitPrice: number }> = [];
    for (const expected of expectedWinners) {
      const line = lines.find((candidate) => candidate.lineNo === expected.lineNo)!;
      const compareResponse = await callRoute(routeServer.baseUrl, 'post', '/api/supplier-quotes/compare', {
        rfqId,
        rfqLineId: line.id,
      });
      const comparison = successData(compareResponse, `line ${line.lineNo} comparison`);
      assert(comparison.rfqLineId === line.id, `line ${line.lineNo} comparison escaped its demand-line scope`);
      const comparedQuotes = comparison.quotes as Array<JsonRecord>;
      assert(comparedQuotes.length === 2, `line ${line.lineNo} did not compare its two scoped supplier offers`);
      assert(comparedQuotes.every((quote) => quote.eligibleForComparison === true),
        `line ${line.lineNo} contains an ineligible local fixture quote`);
      const summary = comparison.summary as JsonRecord;
      assert(Number(summary.lowestPrice) === expected.unitPrice,
        `line ${line.lineNo} lowest price was ${summary.lowestPrice}, expected ${expected.unitPrice}`);
      const expectedWinner = comparedQuotes.find((quote) =>
        (quote.supplier as JsonRecord)?.id === expected.supplierId && Number(quote.unitPrice) === expected.unitPrice);
      assert(expectedWinner, `line ${line.lineNo} is missing its independent lowest-price supplier ${expected.supplierId}`);
      const winnerResponse = await callRoute(routeServer.baseUrl, 'post', `/api/supplier-quotes/${encodeURIComponent(String(expectedWinner.id))}/select-winner`, {});
      const winnerData = successData(winnerResponse, `winner selection for line ${line.lineNo}`);
      assert(winnerData.isWinner === true, `line ${line.lineNo} winner route did not retain the selected quote`);
      selectedWinners.push({
        rfqLineId: line.id,
        lineNo: line.lineNo,
        partNumber: line.partNumber,
        supplierId: expected.supplierId,
        quoteId: String(expectedWinner.id),
        unitPrice: expected.unitPrice,
      });
    }
    for (const line of lines) {
      const winners = await prisma.supplierQuote.count({ where: { rfqLineId: line.id, isWinner: true } });
      assert(winners === 1, `RFQ line ${line.lineNo} does not retain exactly one independent winner`);
    }
    resultArtifact.selectedWinners = selectedWinners;

    const concurrentLine = lines[0];
    const concurrentQuotes = await prisma.supplierQuote.findMany({
      where: { rfqLineId: concurrentLine.id, supersededAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, supplierId: true },
    });
    assert(concurrentQuotes.length === 2, 'A08 concurrent-selection probe requires two live quotes for the same RFQ line');
    const concurrentSelectionBaseUrl = routeServer.baseUrl;
    const concurrentResponses = await Promise.all(concurrentQuotes.map((quote) =>
      callRoute(concurrentSelectionBaseUrl, 'post', `/api/supplier-quotes/${encodeURIComponent(quote.id)}/select-winner`, {})));
    assert(concurrentResponses.every((response) => response.status === 200 || response.status === 409),
      `A08 concurrent-selection requests returned an unexpected status: ${concurrentResponses.map((response) => response.status).join(',')}`);
    const winnerCountAfterRace = await prisma.supplierQuote.count({ where: { rfqLineId: concurrentLine.id, isWinner: true } });
    assert(winnerCountAfterRace === 1, `A08 concurrent selection left ${winnerCountAfterRace} winners for the same demand line`);
    const expectedFirstLineWinner = selectedWinners.find((winner) => winner.lineNo === concurrentLine.lineNo)!;
    const restoreWinner = await callRoute(routeServer.baseUrl, 'post', `/api/supplier-quotes/${encodeURIComponent(expectedFirstLineWinner.quoteId)}/select-winner`, {});
    assert(successData(restoreWinner, 'restore deterministic first-line winner').isWinner === true,
      'A08 race cleanup could not restore the deterministic lowest-price winner');
    assert(await prisma.supplierQuote.count({ where: { rfqLineId: concurrentLine.id, isWinner: true } }) === 1,
      'A08 race cleanup did not retain exactly one winner');
    resultArtifact.concurrentSelectionScenario = {
      rfqLineId: concurrentLine.id,
      quoteIds: concurrentQuotes.map((quote) => quote.id),
      httpStatuses: concurrentResponses.map((response) => response.status),
      winnerCountAfterRace,
      restoredWinnerQuoteId: expectedFirstLineWinner.quoteId,
    };

    const failureRun = supplierRuns[0];
    const previousSuccessfulEmail = await prisma.email.findUniqueOrThrow({ where: { id: failureRun.inboundEmailId! } });
    const followUpBody = replyBody(failureRun.offers, validUntil);
    const failureReplyTransport = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: failureRun.supplierEmail, pass: MAIL_PASSWORD },
    });
    let failureReplyMessageId = '';
    try {
      const sent = await failureReplyTransport.sendMail({
        from: failureRun.supplierEmail,
        to: BUYER_EMAIL,
        subject: `Re: follow-up sourcing acceptance ${failureRun.inquiryId}`,
        text: followUpBody,
        inReplyTo: failureRun.providerMessageId,
        references: [failureRun.providerMessageId],
        messageId: `<supplier-failure-probe-${crypto.randomUUID()}@${MAILBOX_DOMAIN}>`,
      });
      failureReplyMessageId = sent.messageId;
    } finally {
      failureReplyTransport.close();
    }
    assert(normalizeMessageId(failureReplyMessageId), 'failure-probe reply was not accepted by local SMTP');
    const failureSync = await syncEmailAccount(buyerAccount.id, {
      force: true,
      batchSize: 50,
      workerId: 'sourcing-workflow-acceptance-failure-sync',
    });
    assert(failureSync.claimed && failureSync.savedCount === 1 && failureSync.fetchedCount === 1,
      'IMAP did not ingest the follow-up mail used for the model failure scenario');
    const failureEmail = await prisma.email.findFirst({
      where: { accountId: buyerAccount.id, messageId: normalizeMessageId(failureReplyMessageId) },
      select: { id: true, threadMatchStatus: true },
    });
    assert(failureEmail?.threadMatchStatus === 'MATCHED', 'failure-probe reply was not associated with the correct inquiry');
    const emailCountBeforeFailureTask = await prisma.email.count({ where: { accountId: buyerAccount.id } });
    assert(emailCountBeforeFailureTask === 4 && previousSuccessfulEmail.id !== failureEmail.id,
      'failure-probe email was not persisted as a distinct reply');
    fixture.failNextRequests = 1;
    const failedTaskCreate = await callRoute(routeServer.baseUrl, 'post', '/api/sourcing-ai-tasks', {
      type: SUPPLIER_QUOTE_EXTRACTION_TASK,
      emailId: failureEmail.id,
      inquiryId: failureRun.inquiryId,
      idempotencyKey: idempotencyKey('ai-model-failure'),
    });
    assertStatus(failedTaskCreate, 201, 'model-failure task creation');
    const failedTaskId = String(successData(failedTaskCreate, 'model-failure task creation').id);
    const quotesBeforeFailure = await prisma.supplierQuote.count();
    await processPendingSourcingAiTasks(10);
    const failedTask = await waitFor('actual local model-failure task', async () => {
      const task = await prisma.sourcingAiTask.findUnique({
        where: { id: failedTaskId },
        select: { status: true, draftId: true, errorSummary: true },
      });
      return task ?? { status: 'MISSING', draftId: null, errorSummary: null };
    }, (task) => task.status === 'FAILED');
    assert(failedTask.draftId === null && failedTask.errorSummary === 'AI 抽取失败，请稍后重试',
      'model error did not fail safely without a draft');
    assert(await prisma.supplierQuote.count() === quotesBeforeFailure,
      'failed model extraction created a formal supplier quote');
    assert(await prisma.supplierQuoteDraft.count() === 3,
      'failed model extraction created an editable draft');
    resultArtifact.failureScenario = {
      taskId: failedTaskId,
      status: failedTask.status,
      emailId: failureEmail.id,
      errorSummary: failedTask.errorSummary,
      formalQuoteCountUnchanged: true,
    };
    resultArtifact.emailIds = [
      ...supplierRuns.map((run) => ({ supplierId: run.supplierId, emailId: run.inboundEmailId })),
      { supplierId: failureRun.supplierId, emailId: failureEmail.id, scenario: 'model-failure' },
    ];

    assert(fixture.requests.length === 4, `local model fixture saw ${fixture.requests.length} calls, expected three drafts plus one failing call`);
    assert(fixture.requests.every((request) => request.host?.startsWith('127.0.0.1:')),
      'a model provider request escaped the local fixture');
    assert(fixture.requests.every((request) => request.authorization === `Bearer ${MODEL_SECRET}`),
      'model requests did not use the local fixture credential');
    assert(fixture.requests.every((request) => request.model === 'sourcing-fixture-model'),
      'an unexpected model was used for sourcing extraction');

    resultArtifact.ok = true;
    resultArtifact.database = databaseName(process.env.DATABASE_URL!);
    resultArtifact.ports = { smtp: `${SMTP_HOST}:${SMTP_PORT}`, imap: `${IMAP_HOST}:${IMAP_PORT}` };
    resultArtifact.emailAccountId = buyerAccount.id;
    resultArtifact.modelFixtureId = fixtureModelId;
    resultArtifact.outboxEventIds = supplierRuns.map((run) => ({ supplierId: run.supplierId, outboxEventId: run.outboxEventId }));
    resultArtifact.fixtureModelCalls = fixture.requests.length;
    resultArtifact.supplierRecipients = supplierRuns.map((run) => run.supplierEmail);
    console.log(JSON.stringify(resultArtifact));
  } finally {
    await routeServer?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const databaseUrl = process.env.DATABASE_URL;
  const rawMessage = error instanceof Error ? error.message : 'unknown integration failure';
  const safeMessage = rawMessage
    .replaceAll(MODEL_SECRET, '[redacted fixture key]')
    .replaceAll(MAIL_PASSWORD, '[redacted mailbox password]')
    .replace(databaseUrl || '\u0000', '[redacted database url]');
  resultArtifact.ok = false;
  resultArtifact.error = safeMessage;
  console.error(JSON.stringify(resultArtifact));
  process.exitCode = 1;
});
