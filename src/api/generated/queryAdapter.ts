import { authApi, getAccessToken } from '@/api/client';
import { createAeroLinkOpenApiClient, type AeroLinkOpenApiClient } from './client';

export class GeneratedApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GeneratedApiError';
    this.status = status;
  }
}

type GeneratedResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

type ClientOperation<T> = (
  client: AeroLinkOpenApiClient,
  signal?: AbortSignal,
) => Promise<GeneratedResult<T>>;

type ExecuteOptions = {
  idempotencyKey?: string;
};

function messageFromError(error: unknown, status?: number) {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      if (typeof record[key] === 'string' && record[key].trim()) return record[key] as string;
    }
  }
  return status ? `请求失败 (${status})` : '网络错误，请检查服务器是否启动';
}

async function execute<T>(operation: ClientOperation<T>, options: ExecuteOptions = {}): Promise<T> {
  let result = await operation(createAeroLinkOpenApiClient({
    accessToken: getAccessToken(),
    idempotencyKey: options.idempotencyKey,
  }));

  if (result.response.status === 401) {
    try {
      await authApi.refresh();
      result = await operation(createAeroLinkOpenApiClient({
        accessToken: getAccessToken(),
        idempotencyKey: options.idempotencyKey,
      }));
    } catch {
      throw new GeneratedApiError('登录已过期，请重新登录', 401);
    }
  }

  if (!result.response.ok || result.error || result.data === undefined) {
    throw new GeneratedApiError(messageFromError(result.error, result.response.status), result.response.status);
  }

  return result.data;
}

export function generatedQuery<T>(operation: ClientOperation<T>, signal?: AbortSignal) {
  return execute((client) => operation(client, signal));
}

function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `aerolink-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Generated-client mutation adapter with one stable key across refresh retries. */
export function generatedMutation<T>(operation: ClientOperation<T>, idempotencyKey = createIdempotencyKey(), signal?: AbortSignal) {
  return execute((client) => operation(client, signal), { idempotencyKey });
}
