import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const create = vi.fn();
  const resolveModel = vi.fn();
  const warn = vi.fn();

  class APIError extends Error {
    constructor(readonly status?: number) { super('private provider details'); }
  }
  class APIConnectionError extends APIError {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class MockOpenAI {
    static APIError = APIError;
    static APIConnectionError = APIConnectionError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    chat = { completions: { create } };
    constructor(_options: unknown) {}
  }

  return { create, resolveModel, warn, APIConnectionError, APIConnectionTimeoutError, MockOpenAI };
});

vi.mock('openai', () => ({ default: mocks.MockOpenAI }));
vi.mock('./aiModelService.js', () => ({ resolveAIModel: mocks.resolveModel }));
vi.mock('./logger.js', () => ({ logger: { warn: mocks.warn } }));

import { generateCompletion } from './aiCompletion.js';

describe('AI provider transport errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModel.mockResolvedValue({
      id: 'model-config-1', apiKey: 'not-a-real-key', baseUrl: 'https://example.invalid',
      modelId: 'fixture-model', provider: 'openai', config: {},
    });
  });

  it('classifies provider timeouts without exposing the provider exception', async () => {
    mocks.create.mockRejectedValueOnce(new mocks.APIConnectionTimeoutError());

    await expect(generateCompletion([{ role: 'user', content: 'message' }]))
      .rejects.toMatchObject({ message: '模型服务请求超时，请稍后重试', code: 'AI_PROVIDER_TIMEOUT' });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private provider details');
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('example.invalid');
  });

  it('classifies provider connection failures separately from timeouts', async () => {
    mocks.create.mockRejectedValueOnce(new mocks.APIConnectionError());

    await expect(generateCompletion([{ role: 'user', content: 'message' }]))
      .rejects.toMatchObject({ message: '模型服务连接失败，请检查网络后重试', code: 'AI_PROVIDER_CONNECTION_ERROR' });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private provider details');
  });
});
