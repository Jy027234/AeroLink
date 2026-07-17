import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { modelCreateSchema, modelUpdateSchema } from '../lib/validation.js';
import { generateCompletion } from '../lib/aiService.js';
import prisma from '../lib/prisma.js';

const router = Router();
const requireModelManagementRole = requireCapability('model', 'manage');

const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'azure', 'ollama', 'deepseek', 'custom'];

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const models = await prisma.aIModel.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    res.json({
      success: true,
      data: models.map((model) => {
        const config = JSON.parse(model.config);
        delete config.apiKey;
        return {
          id: model.id,
          name: model.name,
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: model.baseUrl,
          isActive: model.isActive,
          isDefault: model.isDefault,
          config,
          capabilities: JSON.parse(model.capabilities),
          createdAt: model.createdAt,
          updatedAt: model.updatedAt,
        };
      }),
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({
      where: { id: req.params.id },
    });

    if (!model) {
      throw new AppError('模型不存在', 404);
    }

    const config = JSON.parse(model.config);
    delete config.apiKey;
    res.json({
      success: true,
      data: {
        id: model.id,
        name: model.name,
        provider: model.provider,
        modelId: model.modelId,
        baseUrl: model.baseUrl,
        isActive: model.isActive,
        isDefault: model.isDefault,
        config,
        capabilities: JSON.parse(model.capabilities),
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
      },
    });
  })
);

router.post(
  '/',
  requireModelManagementRole,
  validateBody(modelCreateSchema),
  asyncHandler(async (req, res) => {
    const { name, provider, modelId, apiKey, baseUrl, isActive, isDefault, config, capabilities } = req.body;

    if (!SUPPORTED_PROVIDERS.includes(provider.toLowerCase())) {
      throw new AppError(`不支持的供应商: ${provider}`, 400);
    }

    if (isDefault) {
      await prisma.aIModel.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const model = await prisma.aIModel.create({
      data: {
        name,
        provider: provider.toLowerCase(),
        modelId,
        apiKey,
        baseUrl,
        isActive: isActive ?? true,
        isDefault: isDefault ?? false,
        config: JSON.stringify(config || {}),
        capabilities: JSON.stringify(capabilities || []),
      },
    });

    res.status(201).json({
      success: true,
      data: {
        ...model,
        config: JSON.parse(model.config),
        capabilities: JSON.parse(model.capabilities),
      },
    });
  })
);

router.patch(
  '/:id',
  requireModelManagementRole,
  validateBody(modelUpdateSchema),
  asyncHandler(async (req, res) => {
    const { name, provider, modelId, apiKey, baseUrl, isActive, isDefault, config, capabilities } = req.body;

    if (provider && !SUPPORTED_PROVIDERS.includes(provider.toLowerCase())) {
      throw new AppError(`不支持的供应商: ${provider}`, 400);
    }

    if (isDefault) {
      await prisma.aIModel.updateMany({
        where: { isDefault: true, id: { not: req.params.id } },
        data: { isDefault: false },
      });
    }

    const model = await prisma.aIModel.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(provider !== undefined && { provider: provider.toLowerCase() }),
        ...(modelId !== undefined && { modelId }),
        ...(apiKey !== undefined && { apiKey }),
        ...(baseUrl !== undefined && { baseUrl }),
        ...(isActive !== undefined && { isActive }),
        ...(isDefault !== undefined && { isDefault }),
        ...(config !== undefined && { config: JSON.stringify(config) }),
        ...(capabilities !== undefined && { capabilities: JSON.stringify(capabilities) }),
      },
    });

    const responseConfig = JSON.parse(model.config);
    delete responseConfig.apiKey;
    res.json({
      success: true,
      data: {
        id: model.id,
        name: model.name,
        provider: model.provider,
        modelId: model.modelId,
        baseUrl: model.baseUrl,
        isActive: model.isActive,
        isDefault: model.isDefault,
        config: responseConfig,
        capabilities: JSON.parse(model.capabilities),
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
      },
    });
  })
);

router.delete(
  '/:id',
  requireModelManagementRole,
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({
      where: { id: req.params.id },
    });

    if (!model) {
      throw new AppError('模型不存在', 404);
    }

    if (model.isDefault) {
      throw new AppError('不能删除默认模型', 400);
    }

    await prisma.aIModel.delete({
      where: { id: req.params.id },
    });

    res.json({
      success: true,
      data: { message: '模型已删除' },
    });
  })
);

router.post(
  '/:id/test',
  requireModelManagementRole,
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({
      where: { id: req.params.id },
    });

    if (!model) {
      throw new AppError('模型不存在', 404);
    }

    if (!model.isActive) {
      throw new AppError('模型未激活', 400);
    }

    const start = Date.now();
    try {
      const result = await generateCompletion(
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say "ok" only.' },
        ],
        { modelId: model.id, temperature: 0, maxTokens: 10 }
      );
      const latency = Date.now() - start;
      res.json({
        success: true,
        data: {
          status: 'ok',
          message: `模型 ${model.name} 连接正常`,
          latency,
          response: result.content.trim(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      res.status(502).json({
        success: false,
        error: `模型连接测试失败: ${message}`,
      });
    }
  })
);

router.post(
  '/:id/set-default',
  requireModelManagementRole,
  asyncHandler(async (req, res) => {
    const model = await prisma.aIModel.findUnique({
      where: { id: req.params.id },
    });

    if (!model) {
      throw new AppError('模型不存在', 404);
    }

    await prisma.aIModel.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });

    const updated = await prisma.aIModel.update({
      where: { id: req.params.id },
      data: { isDefault: true },
    });

    const updatedConfig = JSON.parse(updated.config);
    delete updatedConfig.apiKey;
    res.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        provider: updated.provider,
        modelId: updated.modelId,
        baseUrl: updated.baseUrl,
        isActive: updated.isActive,
        isDefault: updated.isDefault,
        config: updatedConfig,
        capabilities: JSON.parse(updated.capabilities),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  })
);

export default router;
