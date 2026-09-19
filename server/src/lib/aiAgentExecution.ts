import crypto from 'node:crypto';
import { z } from 'zod';
import prisma from './prisma.js';
import { generateCompletion } from './aiCompletion.js';
import { AppError } from '../middleware/errorHandler.js';
import { parseRfqExtractionOutput } from './aiOutputValidation.js';
import { agentPromptsSchema, agentConfigValidationSchema } from './aiAgentRegistry.js';

const promptSchema = agentPromptsSchema;
const configSchema = agentConfigValidationSchema;

export interface AgentExecutionContext { actorId?: string; action?: string }
export interface AgentExecutionResult {
  output: string;
  model: string;
  latency: number;
  promptVersion: number;
  agentId: string;
}

export function renderAgentPrompts(prompts: unknown, input: Record<string, unknown>) {
  const parsed = promptSchema.safeParse(prompts);
  if (!parsed.success) throw new AppError('已发布提示词格式无效，请管理员重新发布', 409, 'STATE_CONFLICT');
  const inputText = JSON.stringify(input);
  if (!inputText || inputText.length > 100_000) throw new AppError('输入内容过大，最多 100,000 字符', 400);
  return parsed.data.map((message) => ({
    role: message.role,
    content: message.content.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined || input[key] === null) {
        throw new AppError(`缺少提示词变量：${key}`, 400, 'VALIDATION_ERROR');
      }
      const value = input[key];
      return typeof value === 'string' ? value : JSON.stringify(value);
    }),
  }));
}

export async function executeAgent(
  agentId: string,
  input: Record<string, unknown>,
  context: AgentExecutionContext = {},
): Promise<AgentExecutionResult> {
  const agent = await prisma.aIAgent.findUnique({ where: { id: agentId } });
  if (!agent) throw new AppError('智能体不存在', 404, 'RESOURCE_NOT_FOUND');
  if (!agent.isActive) throw new AppError('智能体已停用，请联系管理员', 409, 'STATE_CONFLICT');
  if (!agent.publishedVersion) throw new AppError('智能体尚未发布提示词版本', 409, 'STATE_CONFLICT');
  const version = await prisma.aIAgentVersion.findUnique({
    where: { agentId_version: { agentId, version: agent.publishedVersion } },
  });
  if (!version) throw new AppError('已发布提示词版本缺失，请联系管理员', 409, 'STATE_CONFLICT');
  let messages: ReturnType<typeof renderAgentPrompts>;
  let config: z.infer<typeof configSchema>;
  try {
    messages = renderAgentPrompts(JSON.parse(version.prompts), input);
    config = configSchema.parse(JSON.parse(version.config));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('已发布智能体配置无效，请联系管理员', 409, 'STATE_CONFLICT');
  }
  const started = Date.now();
  // Persist attribution before contacting the provider. Logs store hashes and
  // execution metadata rather than business documents or model credentials.
  const log = await prisma.agentLog.create({ data: {
    agentId,
    action: context.action || 'run',
    status: 'RUNNING',
    input: JSON.stringify({
      actorId: context.actorId ?? null,
      promptVersion: version.version,
      inputHash: crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    }),
  } });
  try {
    const result = await generateCompletion(messages, {
      modelId: config.modelId || undefined,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    if (agent.builtinKey === 'rfq_extraction') parseRfqExtractionOutput(result.content);
    await prisma.agentLog.update({ where: { id: log.id }, data: {
      status: 'SUCCESS',
      duration: Date.now() - started,
      output: JSON.stringify({
        promptVersion: version.version,
        model: result.model,
        modelConfigId: result.modelConfigId,
        usage: result.usage,
        outputHash: crypto.createHash('sha256').update(result.content).digest('hex'),
      }),
    } });
    return { output: result.content, model: result.model, latency: result.latency, promptVersion: version.version, agentId };
  } catch (error) {
    const message = error instanceof AppError ? error.message : '智能体运行失败';
    await prisma.agentLog.update({ where: { id: log.id }, data: { status: 'ERROR', error: message, duration: Date.now() - started } });
    throw error instanceof AppError ? error : new AppError(message, 502);
  }
}

export async function executeBuiltinAgent(key: string, input: Record<string, unknown>, context?: AgentExecutionContext) {
  const agent = await prisma.aIAgent.findUnique({ where: { builtinKey: key }, select: { id: true } });
  if (!agent) throw new AppError('内置智能体尚未初始化，请联系管理员', 503, 'STATE_CONFLICT');
  return executeAgent(agent.id, input, context);
}
