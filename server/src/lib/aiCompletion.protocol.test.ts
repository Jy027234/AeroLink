import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn() }));
vi.mock('./prisma.js', () => ({ default: { aIModel: mocks } }));
import { generateCompletion } from './aiCompletion.js';

let server: Server;
let baseUrl: string;
let received: { url?: string; body: Record<string, unknown>; authorization?: string }[] = [];
let responseMode: 'ok' | 'empty' | 'unauthorized' = 'ok';
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, body: JSON.parse(body), authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (responseMode === 'unauthorized') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'SECRET from upstream', type: 'authentication_error' } }));
    } else res.end(JSON.stringify({ id: 'chatcmpl-local-test', object: 'chat.completion', created: 1, model: 'local-returned-model',
      choices: [{ index: 0, message: { role: 'assistant', content: responseMode === 'empty' ? '' : 'Local protocol verified' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
beforeEach(() => {
  vi.clearAllMocks(); received = []; responseMode = 'ok';
  mocks.findFirst.mockResolvedValue({ id: 'local-config', modelId: 'local-test-model', provider: 'custom',
    isActive: true, isDefault: true, apiKey: 'local-protocol-test-only', baseUrl, config: '{}' });
});
describe('actual OpenAI-compatible HTTP transport (local fixture only)', () => {
  it('sends the selected model, prompts and parameters and reports real response metadata', async () => {
    const result = await generateCompletion([{ role: 'user', content: 'Published v2: input' }], { maxTokens: 321, temperature: 0.15 });
    expect(received).toEqual([{ url: '/v1/chat/completions', authorization: 'Bearer local-protocol-test-only',
      body: { model: 'local-test-model', messages: [{ role: 'user', content: 'Published v2: input' }], max_tokens: 321, temperature: 0.15 } }]);
    expect(received[0].body).not.toHaveProperty('thinking');
    expect(result).toMatchObject({ content: 'Local protocol verified', model: 'local-returned-model', modelConfigId: 'local-config', usage: { totalTokens: 15 } });
  });
  it('supports completion-token parameters and omits unsupported temperature for configured OpenAI models', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'local-config', modelId: 'test-openai-model', provider: 'openai',
      isActive: true, apiKey: 'local-protocol-test-only', baseUrl, config: '{"omitTemperature":true}' });
    await generateCompletion([{ role: 'user', content: 'hello' }]);
    expect(received[0].body).toHaveProperty('max_completion_tokens', 2048);
    expect(received[0].body).not.toHaveProperty('max_tokens');
    expect(received[0].body).not.toHaveProperty('temperature');
    expect(received[0].body).not.toHaveProperty('thinking');
  });
  it('disables DeepSeek thinking mode for the initial no-tools completion path', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'deepseek-config', modelId: 'deepseek-flash', provider: 'deepseek',
      isActive: true, isDefault: true, apiKey: 'local-protocol-test-only', baseUrl, config: '{}' });
    await generateCompletion([{ role: 'user', content: 'hello' }]);
    expect(received[0].body).toHaveProperty('thinking', { type: 'disabled' });
    expect(received[0].body).toHaveProperty('max_tokens', 2048);
    expect(received[0].body).not.toHaveProperty('max_completion_tokens');
  });
  it('returns a clear configuration error without contacting any provider when no model exists', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(generateCompletion([{ role: 'user', content: 'hello' }])).rejects.toThrow();
    expect(received).toHaveLength(0);
  });
  it('rejects empty output and sanitizes provider errors', async () => {
    responseMode = 'empty';
    await expect(generateCompletion([{ role: 'user', content: 'hello' }])).rejects.toThrow('未返回可用内容');
    responseMode = 'unauthorized';
    await expect(generateCompletion([{ role: 'user', content: 'hello' }])).rejects.toThrow('认证失败');
  });
});
