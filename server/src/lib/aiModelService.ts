import { decrypt, encrypt } from './crypto.js';
import prisma from './prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export const SUPPORTED_MODEL_PROVIDERS = ['openai', 'deepseek', 'ollama', 'custom'] as const;
export type SupportedModelProvider = (typeof SUPPORTED_MODEL_PROVIDERS)[number];
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

const API_KEY_PREFIX = 'enc:v1:';
const INVALID_MODEL_MESSAGE = '模型配置无效';

export type AIModelRecord = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  isActive: boolean;
  isDefault: boolean;
  config: string;
  capabilities: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ResolvedAIModel = {
  id: string;
  modelId: string;
  provider: SupportedModelProvider;
  apiKey?: string;
  baseUrl?: string;
  config: Record<string, unknown>;
};

export type SerializedAIModel = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  baseUrl: string | null;
  isActive: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
  capabilities: string[];
  hasApiKey: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type AIModelErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_DISABLED'
  | 'MODEL_CONFIGURATION_INVALID'
  | 'MODEL_CREDENTIALS_MISSING';

/**
 * Errors from model selection/configuration are deliberately separate from
 * provider errors.  Routes can turn these into a safe 400 response while the
 * completion layer can retain the same distinction for callers.
 */
export class AIModelError extends AppError {
  readonly modelCode: AIModelErrorCode;

  constructor(code: AIModelErrorCode, message: string, statusCode = 400) {
    super(message, statusCode, code === 'MODEL_NOT_FOUND' ? 'RESOURCE_NOT_FOUND' : 'BAD_REQUEST');
    this.name = 'AIModelError';
    this.modelCode = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string | null | undefined, field: string): Record<string, unknown> {
  if (!value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: ${field} 不是有效 JSON`);
  }

  if (!isRecord(parsed)) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: ${field} 必须是对象`);
  }
  return parsed;
}

function parseJsonRecordForResponse(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A malformed legacy config must not make a read endpoint fail or expose
    // raw stored text. Runtime resolution still rejects malformed config.
    return {};
  }
}

function parseCapabilities(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeProvider(value: unknown): SupportedModelProvider {
  if (typeof value !== 'string') {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: 供应商不能为空`);
  }
  const provider = value.trim().toLowerCase();
  if (!SUPPORTED_MODEL_PROVIDERS.includes(provider as SupportedModelProvider)) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: 不支持的供应商 ${provider || '(空)'}`);
  }
  return provider as SupportedModelProvider;
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: 模型ID不能为空`);
  }
  return value.trim();
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isLocalModelHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLocalModelBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLocalModelHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isOfficialProviderBaseUrl(
  provider: SupportedModelProvider,
  value: string | undefined,
): boolean {
  if (!value) return provider === 'openai' || provider === 'deepseek';

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return false;
    }
    const hostname = normalizeHost(parsed.hostname);
    return (provider === 'openai' && hostname === 'api.openai.com')
      || (provider === 'deepseek' && hostname === 'api.deepseek.com');
  } catch {
    return false;
  }
}

export function validateModelBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: baseUrl 必须是 URL`);
  }

  const baseUrl = value.trim();
  if (!baseUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: baseUrl 不是有效 URL`);
  }

  if (parsed.username || parsed.password) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: baseUrl 不得包含凭据`);
  }

  if (parsed.search || parsed.hash || /[?#]/.test(baseUrl)) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: baseUrl 不得包含 query 或 hash`);
  }

  if (parsed.protocol === 'https:') return baseUrl;
  if (parsed.protocol === 'http:' && isLocalModelHost(parsed.hostname)) return baseUrl;

  throw new AIModelError(
    'MODEL_CONFIGURATION_INVALID',
    `${INVALID_MODEL_MESSAGE}: 非本机模型服务必须使用 HTTPS；HTTP 仅允许 localhost、127.0.0.1 或 ::1`,
  );
}

/** Validate fields that can make a model unusable before writing them. */
export function validateAIModelInput(input: {
  provider: unknown;
  modelId: unknown;
  baseUrl?: unknown;
}): { provider: SupportedModelProvider; modelId: string; baseUrl?: string } {
  const provider = normalizeProvider(input.provider);
  const modelId = normalizeModelId(input.modelId);
  const suppliedBaseUrl = validateModelBaseUrl(input.baseUrl);
  if ((provider === 'ollama' || provider === 'custom') && !suppliedBaseUrl) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: ${provider} 必须配置 baseUrl`);
  }
  const baseUrl = suppliedBaseUrl || (provider === 'deepseek' ? DEEPSEEK_DEFAULT_BASE_URL : undefined);
  return { provider, modelId, baseUrl };
}

function isUsableApiKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() !== 'sk-demo';
}

function decodeStoredApiKey(value: string | null | undefined): string | undefined {
  if (!value || !value.trim()) return undefined;
  const raw = value.trim();
  if (!raw.startsWith(API_KEY_PREFIX)) {
    // Older rows stored the API key in plaintext. Keep reading those rows so
    // existing configurations continue to work until they are edited.
    return isUsableApiKey(raw) ? raw : undefined;
  }

  const payload = raw.slice(API_KEY_PREFIX.length);
  if (!payload) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', '模型密钥无法解密');
  }

  try {
    const decrypted = decrypt(payload);
    return isUsableApiKey(decrypted) ? decrypted.trim() : undefined;
  } catch {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', '模型密钥无法解密');
  }
}

export function encryptAIModelApiKey(value: string): string {
  if (!isUsableApiKey(value)) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', '模型密钥不能为空或不可用');
  }
  try {
    return `${API_KEY_PREFIX}${encrypt(value.trim())}`;
  } catch {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', '模型密钥无法安全保存');
  }
}

function environmentApiKey(provider: SupportedModelProvider, baseUrl?: string | null): string | undefined {
  const openAIKey = process.env.OPENAI_API_KEY?.trim();
  const deepSeekKey = process.env.DEEPSEEK_API_KEY?.trim();

  // Environment credentials are only safe for the provider's official host.
  // A configured alternate endpoint must always carry its own explicit key.
  if (!isOfficialProviderBaseUrl(provider, baseUrl || undefined)) return undefined;

  switch (provider) {
    case 'deepseek':
      return isUsableApiKey(deepSeekKey) ? deepSeekKey : undefined;
    case 'openai':
      return isUsableApiKey(openAIKey) ? openAIKey : undefined;
    case 'custom':
    case 'ollama':
      return undefined;
  }
}

function modelApiKey(model: AIModelRecord, config: Record<string, unknown>): string | undefined {
  const stored = decodeStoredApiKey(model.apiKey);
  if (stored) return stored;

  const legacyConfigKey = typeof config.apiKey === 'string' ? config.apiKey : undefined;
  if (isUsableApiKey(legacyConfigKey)) return legacyConfigKey.trim();

  return undefined;
}

function removeApiKeyFromConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { apiKey: _apiKey, ...safeConfig } = config;
  return safeConfig;
}

function hasPersistedApiKey(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return false;
  const raw = value.trim();
  // Encrypted values can be checked without decrypting. This lets list/detail
  // remain useful even when a deployment has not supplied its key yet.
  return raw.startsWith(API_KEY_PREFIX) || isUsableApiKey(raw);
}

function hasEffectiveApiKey(model: AIModelRecord, config: Record<string, unknown>): boolean {
  const provider = (() => {
    try {
      return normalizeProvider(model.provider);
    } catch {
      return undefined;
    }
  })();
  const legacyConfigKey = typeof config.apiKey === 'string' ? config.apiKey : undefined;
  return hasPersistedApiKey(model.apiKey)
    || isUsableApiKey(legacyConfigKey)
    || (provider ? Boolean(environmentApiKey(provider, model.baseUrl)) : false);
}

function safeBaseUrlForResponse(value: string | null | undefined): string | null {
  try {
    return validateModelBaseUrl(value) ?? null;
  } catch {
    // Legacy rows may contain credentials, query strings, or an unsafe HTTP
    // URL. Never reflect that raw value through a read endpoint.
    return null;
  }
}

export function serializeAIModel(model: AIModelRecord): SerializedAIModel {
  const config = parseJsonRecordForResponse(model.config);
  return {
    id: model.id,
    name: model.name,
    provider: typeof model.provider === 'string' ? model.provider.toLowerCase() : model.provider,
    modelId: model.modelId,
    baseUrl: safeBaseUrlForResponse(model.baseUrl),
    isActive: model.isActive,
    isDefault: model.isDefault,
    config: removeApiKeyFromConfig(config),
    capabilities: parseCapabilities(model.capabilities),
    hasApiKey: hasEffectiveApiKey(model, config),
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function modelQuery(modelId?: string) {
  return modelId
    ? prisma.aIModel.findUnique({ where: { id: modelId } })
    : prisma.aIModel.findFirst({
        where: { isActive: true, isDefault: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
}

/**
 * Resolve a configured model for internal callers. Secrets are returned only
 * from this function and are never part of the route serialization path.
 */
export async function resolveAIModel(modelId?: string): Promise<ResolvedAIModel> {
  const model = await modelQuery(modelId) as AIModelRecord | null;
  if (!model) {
    throw new AIModelError('MODEL_NOT_FOUND', '未找到可用的 AI 模型');
  }
  if (!model.isActive) {
    throw new AIModelError('MODEL_DISABLED', '模型已停用');
  }

  const validated = validateAIModelInput({
    provider: model.provider,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
  });
  const parsedConfig = parseJsonRecord(model.config, 'config');
  const apiKey = modelApiKey(model, parsedConfig)
    || environmentApiKey(validated.provider, validated.baseUrl);

  // Only providers that are explicitly designed to run without credentials
  // may use the local-no-auth path in the completion layer. In particular, a
  // custom HTTP endpoint must not become an unauthenticated SSRF primitive.
  if (!apiKey && !(validated.provider === 'ollama' && isLocalModelBaseUrl(validated.baseUrl))) {
    throw new AIModelError('MODEL_CREDENTIALS_MISSING', '模型缺少可用的 API 密钥');
  }

  return {
    id: model.id,
    modelId: validated.modelId,
    provider: validated.provider,
    ...(apiKey ? { apiKey } : {}),
    ...(validated.baseUrl ? { baseUrl: validated.baseUrl } : {}),
    config: removeApiKeyFromConfig(parsedConfig),
  };
}

export function normalizeAIModelConfig(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: config 必须是对象`);
  }
  return removeApiKeyFromConfig(value);
}

export function normalizeModelCapabilities(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new AIModelError('MODEL_CONFIGURATION_INVALID', `${INVALID_MODEL_MESSAGE}: capabilities 必须是字符串数组`);
  }
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)));
}

export function extractConfigApiKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const apiKey = value.apiKey;
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;
}
