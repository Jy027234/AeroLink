import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  model: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock('./prisma.js', () => ({ default: { aIModel: mocks.model } }));
vi.mock('./crypto.js', () => ({
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
}));

import {
  AIModelError,
  DEEPSEEK_DEFAULT_BASE_URL,
  resolveAIModel,
  serializeAIModel,
  validateModelBaseUrl,
} from './aiModelService.js';

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    name: 'Test model',
    provider: 'openai',
    modelId: 'gpt-test',
    apiKey: null,
    baseUrl: null,
    isActive: true,
    isDefault: true,
    config: '{}',
    capabilities: '[]',
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    updatedAt: new Date('2026-09-11T00:00:00.000Z'),
    ...overrides,
  };
}

describe('aiModelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.decrypt.mockImplementation((value: string) => value);
    mocks.encrypt.mockImplementation((value: string) => `cipher-${value}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a legacy plaintext key and strips config apiKey from the internal config', async () => {
    mocks.model.findUnique.mockResolvedValue(model({
      apiKey: 'legacy-secret',
      config: JSON.stringify({ temperature: 0, apiKey: 'stale-config-secret', omitTemperature: true }),
    }));

    await expect(resolveAIModel('model-1')).resolves.toEqual({
      id: 'model-1',
      modelId: 'gpt-test',
      provider: 'openai',
      apiKey: 'legacy-secret',
      config: { temperature: 0, omitTemperature: true },
    });
  });

  it('decrypts enc:v1 keys and never serializes the key', async () => {
    mocks.decrypt.mockReturnValue('decrypted-secret');
    mocks.model.findUnique.mockResolvedValue(model({ apiKey: 'enc:v1:ciphertext' }));

    await expect(resolveAIModel('model-1')).resolves.toMatchObject({ apiKey: 'decrypted-secret' });
    expect(mocks.decrypt).toHaveBeenCalledWith('ciphertext');

    const serialized = serializeAIModel(model({ apiKey: 'enc:v1:ciphertext' }));
    expect(serialized).toMatchObject({ hasApiKey: true });
    expect(serialized).not.toHaveProperty('apiKey');
    expect(serialized.config).not.toHaveProperty('apiKey');
  });

  it('uses provider environment fallback but never the old demo key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-secret');
    mocks.model.findUnique.mockResolvedValue(model());
    await expect(resolveAIModel('model-1')).resolves.toMatchObject({ apiKey: 'env-secret' });

    vi.stubEnv('OPENAI_API_KEY', 'sk-demo');
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CREDENTIALS_MISSING' });
  });

  it('does not use an OpenAI environment key for DeepSeek', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-env-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    mocks.model.findUnique.mockResolvedValue(model({ provider: 'deepseek', baseUrl: null }));

    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CREDENTIALS_MISSING' });
  });

  it('never sends environment credentials to alternate or custom endpoints', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-env-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-env-secret');

    mocks.model.findUnique.mockResolvedValue(model({
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    }));
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CREDENTIALS_MISSING' });

    mocks.model.findUnique.mockResolvedValue(model({
      provider: 'openai',
      baseUrl: 'https://proxy.example/v1',
    }));
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CREDENTIALS_MISSING' });

    mocks.model.findUnique.mockResolvedValue(model({
      provider: 'deepseek',
      baseUrl: 'https://proxy.example/v1',
    }));
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CREDENTIALS_MISSING' });
  });

  it('uses the official DeepSeek endpoint when no custom base URL is supplied', async () => {
    mocks.model.findUnique.mockResolvedValue(model({
      provider: 'deepseek',
      apiKey: 'deepseek-secret',
      baseUrl: null,
    }));

    await expect(resolveAIModel('model-1')).resolves.toMatchObject({
      provider: 'deepseek',
      baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    });
  });

  it('allows Ollama local no-auth only with an explicit local base URL', async () => {
    mocks.model.findUnique.mockResolvedValue(model({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: null,
    }));
    await expect(resolveAIModel('model-1')).resolves.toMatchObject({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });

    mocks.model.findUnique.mockResolvedValue(model({ provider: 'custom', baseUrl: 'http://localhost:9000/v1' }));
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CREDENTIALS_MISSING' });

    mocks.model.findUnique.mockResolvedValue(model({
      provider: 'ollama',
      baseUrl: 'https://provider.example/v1',
      apiKey: null,
    }));
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CREDENTIALS_MISSING' });
  });

  it('does not silently choose another active model when no active default exists', async () => {
    mocks.model.findFirst.mockResolvedValue(null);
    await expect(resolveAIModel()).rejects.toMatchObject({ modelCode: 'MODEL_NOT_FOUND' });
    expect(mocks.model.findFirst).toHaveBeenCalledWith({
      where: { isActive: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('rejects inactive, missing and unsupported models', async () => {
    mocks.model.findUnique.mockResolvedValue(null);
    await expect(resolveAIModel('missing')).rejects.toMatchObject({ modelCode: 'MODEL_NOT_FOUND' });

    mocks.model.findUnique.mockResolvedValue(model({ isActive: false }));
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_DISABLED' });

    mocks.model.findUnique.mockResolvedValue(model({ provider: 'anthropic' }));
    await expect(resolveAIModel('model-1')).rejects.toMatchObject({ modelCode: 'MODEL_CONFIGURATION_INVALID' });
  });

  it('enforces HTTPS for remote URLs and rejects query/hash fragments', () => {
    expect(validateModelBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(validateModelBaseUrl('http://[::1]:11434/v1')).toBe('http://[::1]:11434/v1');
    expect(() => validateModelBaseUrl('http://example.com/v1')).toThrow(AIModelError);
    expect(() => validateModelBaseUrl('https://example.com/v1?token=secret')).toThrow(AIModelError);
    expect(() => validateModelBaseUrl('https://example.com/v1#fragment')).toThrow(AIModelError);
  });

  it('does not echo unsafe legacy base URLs from read serialization', () => {
    const serialized = serializeAIModel(model({
      provider: 'custom',
      baseUrl: 'https://user:password@example.com/v1?token=secret#fragment',
    }));

    expect(serialized.baseUrl).toBeNull();
    expect(JSON.stringify(serialized)).not.toContain('password');
    expect(JSON.stringify(serialized)).not.toContain('token=secret');
  });
});
