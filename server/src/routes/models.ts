import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { modelCreateSchema, modelUpdateSchema } from '../lib/validation.js';
import { generateCompletion } from '../lib/aiService.js';
import { logger } from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import {
  AIModelError,
  encryptAIModelApiKey,
  extractConfigApiKey,
  normalizeAIModelConfig,
  normalizeModelCapabilities,
  resolveAIModel,
  serializeAIModel,
  validateAIModelInput,
} from '../lib/aiModelService.js';

const router = Router();
const requireModelReadCapability = requireCapability('model', 'read');
const requireModelManagementRole = requireCapability('model', 'manage');

type ModelMutationBody = {
  name?: string;
  provider?: string;
  modelId?: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  config?: Record<string, unknown>;
  capabilities?: string[];
};

type ModelClient = typeof prisma;

const MODEL_DEFAULT_MAX_RETRIES = 3;
const MODEL_DEFAULT_RETRY_DELAY_MS = 10;

function modelErrorToAppError(error: unknown): AppError | undefined {
  if (error instanceof AIModelError) {
    return new AppError(
      error.message,
      error.statusCode,
      error.modelCode === 'MODEL_NOT_FOUND' ? 'RESOURCE_NOT_FOUND' : 'BAD_REQUEST',
    );
  }
  return undefined;
}

function getApiKeyForMutation(body: ModelMutationBody): string | null | undefined {
  if (body.apiKey !== undefined) return body.apiKey;
  return extractConfigApiKey(body.config);
}

function encryptedApiKeyForMutation(body: ModelMutationBody): string | null | undefined {
  const value = getApiKeyForMutation(body);
  if (value === undefined) return undefined;
  if (value === null || !value.trim()) return null;
  return encryptAIModelApiKey(value);
}

function prepareCreate(body: ModelMutationBody) {
  const validated = validateAIModelInput({
    provider: body.provider,
    modelId: body.modelId,
    baseUrl: body.baseUrl,
  });
  const config = normalizeAIModelConfig(body.config);
  const capabilities = normalizeModelCapabilities(body.capabilities);
  const apiKey = encryptedApiKeyForMutation(body);

  return {
    isDefault: body.isDefault ?? false,
    data: {
      name: body.name!,
      provider: validated.provider,
      modelId: validated.modelId,
      apiKey: apiKey ?? null,
      baseUrl: validated.baseUrl ?? null,
      isActive: body.isActive ?? true,
      isDefault: body.isDefault ?? false,
      config: JSON.stringify(config),
      capabilities: JSON.stringify(capabilities),
    },
  };
}

function prepareUpdate(
  existing: {
    provider: string;
    modelId: string;
    baseUrl: string | null;
    config: string;
    apiKey: string | null;
  },
  body: ModelMutationBody,
) {
  const validated = validateAIModelInput({
    provider: body.provider ?? existing.provider,
    modelId: body.modelId ?? existing.modelId,
    baseUrl: body.baseUrl !== undefined ? body.baseUrl : existing.baseUrl,
  });
  const data: Record<string, unknown> = {};

  if (body.name !== undefined) data.name = body.name;
  if (body.provider !== undefined) data.provider = validated.provider;
  if (body.modelId !== undefined) data.modelId = validated.modelId;
  if (body.baseUrl !== undefined) data.baseUrl = validated.baseUrl ?? null;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.isDefault !== undefined) data.isDefault = body.isDefault;
  if (body.config !== undefined) data.config = JSON.stringify(normalizeAIModelConfig(body.config));
  if (body.capabilities !== undefined) data.capabilities = JSON.stringify(normalizeModelCapabilities(body.capabilities));

  const apiKey = encryptedApiKeyForMutation(body);
  if (apiKey !== undefined) data.apiKey = apiKey;

  return {
    isDefault: body.isDefault === true,
    data,
  };
}

function isPostgresDatabaseUrl(value: string | undefined): boolean {
  return value?.startsWith('postgres://') === true || value?.startsWith('postgresql://') === true;
}

function isRetryableModelTransactionError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'P2034' || code === '40001' || code === '40P01' || code === 'SQLITE_BUSY') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /deadlock|serialization failure|could not serialize|write conflict|database is locked/i.test(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inTransaction<T>(callback: (tx: ModelClient) => Promise<T>): Promise<T> {
  const transaction = (prisma as typeof prisma & {
    $transaction?: <R>(
      fn: (tx: ModelClient) => Promise<R>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
    ) => Promise<R>;
  }).$transaction?.bind(prisma);
  // Prisma always provides $transaction. The fallback keeps isolated route
  // tests with a minimal mock deterministic while production remains atomic.
  if (!transaction) return callback(prisma);

  // PostgreSQL's default READ COMMITTED isolation allows two simultaneous
  // "clear defaults then set one" transactions to both observe no competing
  // default. Serializable retries close that race without adding a
  // PostgreSQL-only schema constraint, keeping the SQLite schema usable.
  const serializable = isPostgresDatabaseUrl(process.env.DATABASE_URL);
  const options = serializable
    ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 }
    : undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < MODEL_DEFAULT_MAX_RETRIES; attempt += 1) {
    try {
      return options ? await transaction(callback, options) : await transaction(callback);
    } catch (error) {
      lastError = error;
      if (!isRetryableModelTransactionError(error) || attempt === MODEL_DEFAULT_MAX_RETRIES - 1) throw error;
      await sleep(MODEL_DEFAULT_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

router.get(
  '/',
  requireModelReadCapability,
  asyncHandler(async (_req, res) => {
    const models = await prisma.aIModel.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    res.json({
      success: true,
      data: models.map(serializeAIModel),
    });
  }),
);

router.get(
  '/:id',
  requireModelReadCapability,
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({
      where: { id: req.params.id },
    });

    if (!model) {
      throw new AppError('模型不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: serializeAIModel(model),
    });
  }),
);

router.post(
  '/',
  requireModelManagementRole,
  validateBody(modelCreateSchema),
  asyncHandler(async (req, res) => {
    try {
      const prepared = prepareCreate(req.body as ModelMutationBody);
      const model = await inTransaction(async (tx) => {
        if (prepared.isDefault) {
          await tx.aIModel.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.aIModel.create({ data: prepared.data });
      });

      res.status(201).json({ success: true, data: serializeAIModel(model) });
    } catch (error) {
      const mapped = modelErrorToAppError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }),
);

router.patch(
  '/:id',
  requireModelManagementRole,
  validateBody(modelUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.aIModel.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError('模型不存在', 404, 'RESOURCE_NOT_FOUND');
    if (req.body.isDefault === true && req.body.isActive === false) {
      throw new AppError('停用模型不能设为默认模型', 400, 'BAD_REQUEST');
    }
    if (req.body.isDefault === true && !existing.isActive) {
      throw new AppError('停用模型不能设为默认模型', 400, 'BAD_REQUEST');
    }

    try {
      const prepared = prepareUpdate(existing, req.body as ModelMutationBody);
      const model = await inTransaction(async (tx) => {
        if (prepared.isDefault) {
          await tx.aIModel.updateMany({
            where: { isDefault: true, id: { not: req.params.id } },
            data: { isDefault: false },
          });
        }
        return tx.aIModel.update({
          where: { id: req.params.id },
          data: prepared.data,
        });
      });

      res.json({ success: true, data: serializeAIModel(model) });
    } catch (error) {
      const mapped = modelErrorToAppError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }),
);

router.delete(
  '/:id',
  requireModelManagementRole,
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({ where: { id: req.params.id } });
    if (!model) throw new AppError('模型不存在', 404, 'RESOURCE_NOT_FOUND');
    if (model.isDefault) throw new AppError('不能删除默认模型', 400, 'BAD_REQUEST');

    await prisma.aIModel.delete({ where: { id: req.params.id } });
    res.json({ success: true, data: { message: '模型已删除' } });
  }),
);

router.post(
  '/:id/test',
  requireModelManagementRole,
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({ where: { id: req.params.id } });
    if (!model) throw new AppError('模型不存在', 404, 'RESOURCE_NOT_FOUND');
    if (!model.isActive) throw new AppError('模型未激活', 400, 'BAD_REQUEST');

    const start = Date.now();
    try {
      // Resolve first so disabled/missing credentials/configuration are a
      // controlled 400 rather than being mistaken for an upstream outage.
      await resolveAIModel(model.id);
      const result = await generateCompletion(
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say "ok" only.' },
        ],
        { modelId: model.id, temperature: 0, maxTokens: 512 },
      );
      const latency = Date.now() - start;
      res.json({
        success: true,
        data: {
          status: 'ok',
          message: `模型 ${model.name} 连接正常`,
          latency,
          response: result.content.trim().slice(0, 2000),
        },
      });
    } catch (error) {
      const mapped = modelErrorToAppError(error);
      if (mapped) throw mapped;
      logger.warn({ modelId: model.id }, 'AI model connection test failed');
      res.status(502).json({
        success: false,
        code: 'BAD_REQUEST',
        error: '模型连接测试失败，请检查模型配置或上游服务',
        message: '模型连接测试失败，请检查模型配置或上游服务',
      });
    }
  }),
);

router.post(
  '/:id/set-default',
  requireModelManagementRole,
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({ where: { id: req.params.id } });
    if (!model) throw new AppError('模型不存在', 404, 'RESOURCE_NOT_FOUND');
    if (!model.isActive) throw new AppError('停用模型不能设为默认模型', 400, 'BAD_REQUEST');

    const updated = await inTransaction(async (tx) => {
      await tx.aIModel.updateMany({
        where: { isDefault: true, id: { not: req.params.id } },
        data: { isDefault: false },
      });
      return tx.aIModel.update({
        where: { id: req.params.id },
        data: { isDefault: true },
      });
    });

    res.json({ success: true, data: serializeAIModel(updated) });
  }),
);

export default router;
