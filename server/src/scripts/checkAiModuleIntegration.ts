/**
 * End-to-end AI module check.
 *
 * This script intentionally does not load dotenv or the main HTTP entrypoint.
 * It only runs when the caller explicitly points DATABASE_URL at a PostgreSQL
 * database whose name contains `ai_module_test` and confirms `isolated`.
 * The model provider is a local OpenAI-compatible HTTP fixture; no external
 * model, email, or business system is contacted.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import type { AuthRequest } from '../middleware/auth.js';

const CONFIRMATION = 'isolated';
const DEMO_AGENT_IDS = ['agent001', 'agent002', 'agent003', 'agent004'];
const DEMO_MODEL_IDS = ['model001', 'model002', 'model003', 'model004'];
const BUILTIN_KEYS = ['rfq_extraction', 'quote_analysis', 'customer_email', 'business_chat'] as const;
const MODEL_SECRET = 'ai-module-integration-secret';

type JsonRecord = Record<string, unknown>;

type FixtureRequest = {
  method: string;
  url: string;
  host: string | undefined;
  authorization: string | undefined;
  model: string | undefined;
  messages: Array<{ role: string; content: string }>;
};

type Fixture = {
  baseUrl: string;
  requests: FixtureRequest[];
  close: () => Promise<void>;
};

type AppResponse = {
  status: number;
  body: JsonRecord;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function databaseName(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

function assertIsolatedEnvironment() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required; refusing to use an implicit or dotenv database');
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('AI module integration requires a PostgreSQL DATABASE_URL');
  }
  if (!databaseName(databaseUrl).toLowerCase().includes('ai_module_test')) {
    throw new Error('DATABASE_URL database name must contain ai_module_test');
  }
  if (process.env.AI_MODULE_INTEGRATION_CONFIRM !== CONFIRMATION) {
    throw new Error('Set AI_MODULE_INTEGRATION_CONFIRM=isolated to authorize the isolated database check');
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startFixture(): Promise<Fixture> {
  const requests: FixtureRequest[] = [];
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

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages
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

    const prompt = messages.map((message) => message.content).join('\n');
    const extraction = prompt.includes('邮件') || prompt.includes('subject') || prompt.includes('RFQ');
    let content: string;
    if (extraction) {
      content = prompt.includes('V2_EXTRACTION_MARKER')
        ? JSON.stringify({ type: 'INQUIRY', partNumbers: ['V2-PART'], quantities: [2], urgency: 'URGENT' })
        : JSON.stringify({ type: 'INQUIRY', partNumbers: ['V1-PART'], quantities: [1], urgency: 'STANDARD' });
    } else if (prompt.includes('V3_CHAT_MARKER')) {
      content = 'V3_CHAT_OUTPUT';
    } else if (prompt.includes('V2_CHAT_MARKER')) {
      content = 'V2_CHAT_OUTPUT';
    } else {
      content = 'V1_CHAT_OUTPUT';
    }

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: `fixture-${requests.length}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'fixture did not expose a TCP address');
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeIdleConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function testUser(userId: string, email: string) {
  return {
    id: userId,
    email,
    name: 'AI module integration user',
    role: 'manager',
    department: 'management',
    avatar: null,
  };
}

function createApp(
  user: ReturnType<typeof testUser>,
  agentsRouter: express.Router,
  modelsRouter: express.Router,
  aiRouter: express.Router,
  errorHandler: express.ErrorRequestHandler,
) {
  const app = express();
  // Route bodies are parsed locally in this isolated app; the production
  // index is deliberately not imported because it would start a real server.
  app.use(express.json({ limit: '2mb' }));
  app.use((request, _response, next) => {
    (request as AuthRequest).user = user;
    next();
  });
  app.use('/api/agents', agentsRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/ai', aiRouter);
  app.use(errorHandler);
  return app;
}

type LocalHttpServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

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
): Promise<AppResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: method === 'get' ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: (parsed && typeof parsed === 'object' ? parsed : {}) as JsonRecord };
}

function successData(response: AppResponse, label: string): JsonRecord {
  assert(response.status >= 200 && response.status < 300, `${label} returned HTTP ${response.status}`);
  assert(response.body.success === true, `${label} did not return success`);
  assert(response.body.data && typeof response.body.data === 'object', `${label} has no data payload`);
  return response.body.data as JsonRecord;
}

function firstArrayItem(record: JsonRecord, key: string): unknown {
  const value = record[key];
  return Array.isArray(value) ? value[0] : undefined;
}

function assertNoSecret(response: AppResponse, label: string) {
  const serialized = JSON.stringify(response.body);
  assert(!serialized.includes(MODEL_SECRET), `${label} echoed the configured API key`);
  assert(!serialized.includes('enc:v1:'), `${label} echoed the encrypted API key`);
}

function assertStatus(response: AppResponse, status: number, label: string) {
  assert(response.status === status, `${label} returned HTTP ${response.status}, expected ${status}`);
}

async function main() {
  assertIsolatedEnvironment();

  // Use an ephemeral encryption key for this process. This never reads or
  // writes a real provider credential or the user's dotenv configuration.
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  const [{ default: prisma }, { ensureBuiltinAgents }, { default: agentsRouter }, { default: modelsRouter }, { default: aiRouter }, { errorHandler }] = await Promise.all([
    import('../lib/prisma.js'),
    import('../lib/aiAgentRegistry.js'),
    import('../routes/agents.js'),
    import('../routes/models.js'),
    import('../routes/ai.js'),
    import('../middleware/errorHandler.js'),
  ]);

  let userId: string | undefined;
  let fixture: Fixture | undefined;
  let routeServer: LocalHttpServer | undefined;
  const createdModelIds = new Set<string>();
  let createdBuiltinIds: string[] = [];
  let outboundEmailCount = 0;
  let inboundEmailCount = 0;

  try {
    const databaseProbe = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    assert(databaseProbe[0]?.ok === 1, 'isolated PostgreSQL probe failed');

    const initialAgents = await prisma.aIAgent.findMany({ select: { id: true } });
    const initialModels = await prisma.aIModel.findMany({ select: { id: true } });
    assert(initialAgents.length === 0, 'isolated AI module database already contains agent rows');
    assert(initialModels.length === 0, 'isolated AI module database already contains model rows');
    const [demoAgentCount, demoModelCount] = await Promise.all([
      prisma.aIAgent.count({ where: { id: { in: DEMO_AGENT_IDS } } }),
      prisma.aIModel.count({ where: { id: { in: DEMO_MODEL_IDS } } }),
    ]);
    assert(demoAgentCount === 0 && demoModelCount === 0, 'demo seed rows are present in the isolated database');
    [outboundEmailCount, inboundEmailCount] = await Promise.all([
      prisma.outboundEmail.count(),
      prisma.email.count(),
    ]);

    userId = crypto.randomUUID();
    const email = `ai-module-${userId}@example.test`;
    await prisma.user.create({
      data: {
        id: userId,
        email,
        name: 'AI module integration user',
        password: 'integration-only-password',
        role: 'manager',
        department: 'management',
      },
    });
    const user = testUser(userId, email);
    const activeFixture = await startFixture();
    fixture = activeFixture;
    const app = createApp(user, agentsRouter, modelsRouter, aiRouter, errorHandler);
    routeServer = await startExpressServer(app);
    const routeBaseUrl = routeServer.baseUrl;

    await ensureBuiltinAgents();
    await ensureBuiltinAgents();
    const builtins = await prisma.aIAgent.findMany({
      where: { builtinKey: { in: [...BUILTIN_KEYS] } },
      select: { id: true, builtinKey: true, draftRevision: true, publishedVersion: true },
    });
    assert(builtins.length === BUILTIN_KEYS.length, 'builtin initialization did not create exactly four agents');
    assert(new Set(builtins.map((agent) => agent.builtinKey)).size === BUILTIN_KEYS.length, 'builtin keys are not unique');
    assert((await prisma.aIAgentVersion.count()) === BUILTIN_KEYS.length, 'builtin initialization did not create exactly one v1 per agent');
    createdBuiltinIds = builtins.map((agent) => agent.id);
    for (const builtin of builtins) {
      assert(builtin.publishedVersion === 1, `builtin ${builtin.builtinKey} did not publish v1`);
      assert(builtin.draftRevision === 0, `builtin ${builtin.builtinKey} was unexpectedly edited during initialization`);
    }

    const modelName = `AI module fixture ${userId}`;
    const modelResponse = await callRoute(routeBaseUrl, 'post', '/api/models', {
      name: modelName,
      provider: 'custom',
      modelId: 'fixture-model',
      baseUrl: activeFixture.baseUrl,
      apiKey: MODEL_SECRET,
      isActive: true,
      isDefault: true,
      config: { temperature: 0, maxTokens: 128 },
    });
    const modelData = successData(modelResponse, 'fixture model creation');
    assertNoSecret(modelResponse, 'fixture model creation');
    assert(modelData.hasApiKey === true, 'fixture model did not report hasApiKey');
    const modelId = String(modelData.id);
    createdModelIds.add(modelId);
    const persistedModel = await prisma.aIModel.findUnique({ where: { id: modelId } });
    assert(Boolean(persistedModel?.apiKey?.startsWith('enc:v1:')), 'fixture API key was not encrypted with enc:v1');
    const modelDetail = await callRoute(routeBaseUrl, 'get', `/api/models/${modelId}`);
    successData(modelDetail, 'fixture model detail');
    assertNoSecret(modelDetail, 'fixture model detail');

    const agentRows = await callRoute(routeBaseUrl, 'get', '/api/agents/');
    const agents = successData(agentRows, 'agent listing') as unknown as Array<JsonRecord>;
    const findAgent = (key: string) => agents.find((agent) => agent.builtinKey === key);
    const chat = findAgent('business_chat');
    const extraction = findAgent('rfq_extraction');
    assert(chat && extraction, 'required business chat/extraction builtins are missing');

    const chatId = String(chat.id);
    const extractionId = String(extraction.id);
    const chatRevision = Number(chat.draftRevision);
    const extractionRevision = Number(extraction.draftRevision);

    const initialChat = await callRoute(routeBaseUrl, 'post', '/api/ai/chat', { message: 'initial chat' });
    const initialChatData = successData(initialChat, 'initial chat execution');
    assert(initialChatData.content === 'V1_CHAT_OUTPUT', 'initial chat did not use published v1');
    assert((initialChatData.ai as JsonRecord)?.promptVersion === 1, 'initial chat did not report prompt version 1');

    const initialExtraction = await callRoute(routeBaseUrl, 'post', '/api/ai/parse-email', {
      subject: 'initial RFQ',
      body: 'Please quote one test part',
    });
    const initialExtractionData = successData(initialExtraction, 'initial extraction execution');
    assert((initialExtractionData as JsonRecord).partNumbers instanceof Array, 'initial extraction did not return parsed data');
    assert((initialExtractionData.ai as JsonRecord)?.promptVersion === 1, 'initial extraction did not report prompt version 1');

    const chatPatch = await callRoute(routeBaseUrl, 'patch', `/api/agents/${chatId}`, {
      expectedRevision: chatRevision,
      prompts: [{ role: 'user', content: 'V2_CHAT_MARKER {{message}}' }],
      config: { modelId, temperature: 0, maxTokens: 128 },
    });
    const patchedChat = successData(chatPatch, 'chat draft save');
    assert(Number(patchedChat.draftRevision) === chatRevision + 1, 'chat draft revision did not increment');

    const stalePatch = await callRoute(routeBaseUrl, 'patch', `/api/agents/${chatId}`, {
      expectedRevision: chatRevision,
      prompts: [{ role: 'user', content: 'stale draft' }],
      config: { modelId, temperature: 0, maxTokens: 128 },
    });
    assertStatus(stalePatch, 409, 'stale chat draft');

    const draftChat = await callRoute(routeBaseUrl, 'post', '/api/ai/chat', { message: 'draft chat' });
    const draftChatData = successData(draftChat, 'chat execution after draft save');
    assert(draftChatData.content === 'V1_CHAT_OUTPUT', 'saving a chat draft changed runtime output before publish');
    assert((draftChatData.ai as JsonRecord)?.promptVersion === 1, 'draft chat execution did not retain published v1');

    const extractionPatch = await callRoute(routeBaseUrl, 'patch', `/api/agents/${extractionId}`, {
      expectedRevision: extractionRevision,
      prompts: [{ role: 'user', content: 'V2_EXTRACTION_MARKER {{subject}} {{body}}' }],
      config: { modelId, temperature: 0, maxTokens: 128 },
    });
    const patchedExtraction = successData(extractionPatch, 'extraction draft save');
    assert(Number(patchedExtraction.draftRevision) === extractionRevision + 1, 'extraction draft revision did not increment');

    const draftExtraction = await callRoute(routeBaseUrl, 'post', '/api/ai/parse-email', {
      subject: 'draft RFQ',
      body: 'Please quote draft test part',
    });
    const draftExtractionData = successData(draftExtraction, 'extraction execution after draft save');
    assert(firstArrayItem(draftExtractionData, 'partNumbers') === 'V1-PART', 'saving extraction draft changed runtime output before publish');
    assert((draftExtractionData.ai as JsonRecord)?.promptVersion === 1, 'draft extraction did not retain published v1');

    const extractionPublish = await callRoute(routeBaseUrl, 'post', `/api/agents/${extractionId}/publish`, {
      expectedRevision: extractionRevision + 1,
    });
    const publishedExtraction = successData(extractionPublish, 'extraction publish');
    assert(publishedExtraction.publishedVersion === 2, 'extraction publish did not create v2');

    const publishedExtractionRun = await callRoute(routeBaseUrl, 'post', '/api/ai/parse-email', {
      subject: 'published RFQ',
      body: 'Please quote published test part',
    });
    const publishedExtractionData = successData(publishedExtractionRun, 'published extraction execution');
    assert(firstArrayItem(publishedExtractionData, 'partNumbers') === 'V2-PART', 'published extraction did not use v2 prompt');
    assert((publishedExtractionData.ai as JsonRecord)?.promptVersion === 2, 'published extraction did not report v2');

    const chatPublish = await callRoute(routeBaseUrl, 'post', `/api/agents/${chatId}/publish`, {
      expectedRevision: chatRevision + 1,
    });
    const publishedChat = successData(chatPublish, 'chat publish');
    assert(publishedChat.publishedVersion === 2, 'chat publish did not create v2');

    const publishedChatRun = await callRoute(routeBaseUrl, 'post', '/api/ai/chat', { message: 'published chat' });
    const publishedChatData = successData(publishedChatRun, 'published chat execution');
    assert(publishedChatData.content === 'V2_CHAT_OUTPUT', 'published chat did not use v2 prompt');
    assert((publishedChatData.ai as JsonRecord)?.promptVersion === 2, 'published chat did not report v2');

    const chatAfterV2 = await callRoute(routeBaseUrl, 'patch', `/api/agents/${chatId}`, {
      expectedRevision: chatRevision + 2,
      prompts: [{ role: 'user', content: 'V3_CHAT_MARKER {{message}}' }],
      config: { modelId, temperature: 0, maxTokens: 128 },
    });
    const chatV3Draft = successData(chatAfterV2, 'chat v3 draft save');
    const v3Revision = Number(chatV3Draft.draftRevision);
    const concurrentPublish = await Promise.all([
      callRoute(routeBaseUrl, 'post', `/api/agents/${chatId}/publish`, { expectedRevision: v3Revision }),
      callRoute(routeBaseUrl, 'post', `/api/agents/${chatId}/publish`, { expectedRevision: v3Revision }),
    ]);
    const concurrentStatuses = concurrentPublish.map((response) => response.status).sort((a, b) => a - b);
    assert(concurrentStatuses[0] === 200 && concurrentStatuses[1] === 409, `concurrent publish statuses were ${concurrentStatuses.join(',')}`);
    const afterConcurrentPublish = await callRoute(routeBaseUrl, 'get', `/api/agents/${chatId}`);
    const chatAfterConcurrent = successData(afterConcurrentPublish, 'chat concurrent publish read');
    assert(chatAfterConcurrent.publishedVersion === 3, 'concurrent publish did not leave one v3 published snapshot');

    const versionsResponse = await callRoute(routeBaseUrl, 'get', `/api/agents/${chatId}/versions`);
    const versions = successData(versionsResponse, 'chat version listing') as unknown as Array<JsonRecord>;
    const firstVersion = versions.find((version) => version.version === 1);
    assert(firstVersion, 'chat v1 snapshot is missing');
    const restore = await callRoute(routeBaseUrl, 'post', `/api/agents/${chatId}/restore`, {
      version: 1,
      expectedRevision: Number(chatAfterConcurrent.draftRevision),
    });
    const restoredChat = successData(restore, 'chat draft restore');
    assert(restoredChat.publishedVersion === 3, 'restore changed the published pointer');
    assert(JSON.stringify(restoredChat.prompts) === JSON.stringify(firstVersion.prompts), 'restore did not copy the v1 draft snapshot');
    const restoredPublishedRun = await callRoute(routeBaseUrl, 'post', '/api/ai/chat', { message: 'after restore' });
    const restoredPublishedData = successData(restoredPublishedRun, 'chat execution after draft restore');
    assert(restoredPublishedData.content === 'V3_CHAT_OUTPUT', 'restoring a draft changed the published runtime');
    assert((restoredPublishedData.ai as JsonRecord)?.promptVersion === 3, 'restoring a draft changed the published version');

    const concurrentModelNames = [`AI module concurrent A ${userId}`, `AI module concurrent B ${userId}`];
    const concurrentModels = await Promise.all(concurrentModelNames.map((name) => callRoute(routeBaseUrl, 'post', '/api/models', {
      name,
      provider: 'custom',
      modelId: 'fixture-model',
      baseUrl: activeFixture.baseUrl,
      apiKey: `${MODEL_SECRET}-${name.slice(-1)}`,
      isActive: true,
      isDefault: true,
      config: {},
    })));
    concurrentModels.forEach((response, index) => {
      const data = successData(response, `concurrent model ${index + 1}`);
      assertNoSecret(response, `concurrent model ${index + 1}`);
      createdModelIds.add(String(data.id));
    });
    assert(await prisma.aIModel.count({ where: { isDefault: true } }) === 1, 'concurrent model defaults left more than one default');

    assert(activeFixture.requests.length >= 8, 'fixture did not observe the expected business model calls');
    assert(activeFixture.requests.every((entry) => entry.host?.startsWith('127.0.0.1:')), 'a model request escaped the local fixture');
    assert(activeFixture.requests.every((entry) => entry.authorization?.startsWith('Bearer ')), 'fixture calls did not carry the configured key');
    assert((await prisma.outboundEmail.count()) === outboundEmailCount, 'AI integration unexpectedly created outbound email records');
    assert((await prisma.email.count()) === inboundEmailCount, 'AI integration unexpectedly created inbound email records');

    console.log(JSON.stringify({
      ok: true,
      database: databaseName(process.env.DATABASE_URL!),
      builtins: BUILTIN_KEYS.length,
      fixtureCalls: activeFixture.requests.length,
      publishedVersions: { chat: 3, extraction: 2 },
      defaultModelCount: await prisma.aIModel.count({ where: { isDefault: true } }),
    }));
  } finally {
    // This database is explicitly isolated, but clean only rows created by
    // this run so a failed assertion can be rerun after a normal rollback.
    for (const modelId of createdModelIds) {
      await prisma.aIModel.delete({ where: { id: modelId } }).catch(() => undefined);
    }
    for (const agentId of createdBuiltinIds) {
      await prisma.agentLog.deleteMany({ where: { agentId } }).catch(() => undefined);
      await prisma.aIAgentVersion.deleteMany({ where: { agentId } }).catch(() => undefined);
      await prisma.aIAgent.delete({ where: { id: agentId } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await routeServer?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown integration failure';
  const databaseUrl = process.env.DATABASE_URL;
  const safeMessage = message
    .replaceAll(MODEL_SECRET, '[redacted]')
    .replace(databaseUrl || '\u0000', '[redacted database url]');
  console.error(`AI module integration failed: ${safeMessage}`);
  process.exitCode = 1;
});
