import OpenAI from 'openai';
import { AppError } from '../middleware/errorHandler.js';
import { resolveAIModel } from './aiModelService.js';
import { logger } from './logger.js';

export interface AICompletionOptions {
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AICompletionResult {
  content: string;
  model: string;
  modelConfigId: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latency: number;
}

export async function generateCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: AICompletionOptions = {},
): Promise<AICompletionResult> {
  const model = await resolveAIModel(options.modelId);
  const started = Date.now();
  const client = new OpenAI({
    apiKey: model.apiKey || 'local-no-auth',
    baseURL: model.baseUrl || undefined,
    timeout: 60_000,
    maxRetries: 0,
  });
  const maxTokens = options.maxTokens ?? 2048;
  try {
    const response = await client.chat.completions.create({
      model: model.modelId,
      messages,
      ...(model.config.omitTemperature === true ? {} : { temperature: options.temperature ?? 0.7 }),
      ...(model.provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    });
    const content = response.choices[0]?.message?.content;
    if (!content?.trim()) throw new AppError('模型未返回可用内容，请检查模型配置后重试', 502);
    return {
      content,
      model: response.model || model.modelId,
      modelConfigId: model.id,
      latency: Date.now() - started,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    // Provider errors can include request headers, prompts, URLs or credentials.
    logger.warn({ modelConfigId: model.id, upstreamStatus: status }, 'AI provider request failed');
    throw new AppError(status === 401 || status === 403
      ? '模型服务认证失败，请管理员检查密钥与模型权限'
      : status === 429 ? '模型服务额度或频率受限，请稍后重试'
        : '模型调用失败，请检查模型兼容性、网络及参数后重试', 502);
  }
}
