import { z } from 'zod';
import prisma from './prisma.js';

export type AgentPromptRole = 'system' | 'user' | 'assistant';

export interface AgentPrompt {
  role: AgentPromptRole;
  content: string;
}

export interface AgentConfig {
  modelId?: string | null;
  temperature?: number;
  maxTokens?: number;
}

export interface BuiltinAgentDefinition {
  key: string;
  name: string;
  type: string;
  description: string;
  prompts: AgentPrompt[];
  config: AgentConfig;
  variables: string[];
  inputExample: Record<string, unknown>;
}

const rfqExtraction: BuiltinAgentDefinition = {
  key: 'rfq_extraction',
  name: 'RFQ需求提取',
  type: 'RFQ_EXTRACTION',
  description: '从客户邮件中提取航材需求、件号、数量和紧急程度。',
  prompts: [
    {
      role: 'system',
      content: '你是专业的航材需求提取助手。只返回合法 JSON，不要输出 Markdown 或解释文字。type 只能是 AOG、STANDARD、INQUIRY、SPAM；urgency 只能是 AOG、URGENT、STANDARD。partNumbers 与 quantities 必须是一一对应且长度相同，quantities 只能是来源中明确给出的正整数；requiredDate（如能确定）必须是 YYYY-MM-DD。只提取邮件明确提供的信息，不要猜测或编造数字。',
    },
    {
      role: 'user',
      content: '请分析下面的客户邮件并提取 RFQ 信息。\n邮件主题：{{subject}}\n邮件正文：{{body}}\n返回 type、partNumbers、quantities、urgency、aircraftType、requiredDate 字段；没有明确值时省略可选字段。',
    },
  ],
  config: { modelId: null, temperature: 0.1, maxTokens: 1024 },
  variables: ['subject', 'body'],
  inputExample: {
    subject: 'AOG RFQ: BAC31GK0020 x 2',
    body: 'Please quote BAC31GK0020, quantity 2, required for a Boeing 737 AOG.',
  },
};

const quoteAnalysis: BuiltinAgentDefinition = {
  key: 'quote_analysis',
  name: '报价分析',
  type: 'QUOTE_ANALYSIS',
  description: '结合 RFQ 和供应商报价生成定价、风险与竞争策略建议。',
  prompts: [
    {
      role: 'system',
      content: '你是航材交易领域的资深销售专家。请用中文回答，条理清晰，并明确区分事实、假设和建议。只使用输入中已核实的信息；不得把未核实报价、不同币种报价、库存、适航证书或实时市场数据当作事实。你没有实时市场数据或外部工具访问权限，不能编造市场价格、库存数量、证书或供应能力。',
    },
    {
      role: 'user',
      content: '请分析以下 RFQ 和供应商报价。\nRFQ 详情：{{rfqDetails}}\n供应商报价：{{supplierQuotes}}\n请给出市场分析、定价建议、风险提示和竞争策略。比较价格前先核对币种、有效期、数量和来源状态；不同币种或未核实报价只能列为待核，不能直接比较或计算。',
    },
  ],
  config: { modelId: null, temperature: 0.7, maxTokens: 2048 },
  variables: ['rfqDetails', 'supplierQuotes'],
  inputExample: {
    rfqDetails: { partNumber: 'BAC31GK0020', quantity: 2, urgency: 'AOG' },
    supplierQuotes: [{ supplier: 'Example Supplier', unitPrice: 1200, leadTimeDays: 3 }],
  },
};

const customerEmail: BuiltinAgentDefinition = {
  key: 'customer_email',
  name: '客户邮件草稿',
  type: 'CUSTOMER_EMAIL',
  description: '根据面向客户的完整报价信息生成专业商务邮件草稿。',
  prompts: [
    {
      role: 'system',
      content: '你是航材交易平台的商务邮件撰写专家。邮件应专业、准确、礼貌，不得虚构报价中没有的信息。',
    },
    {
      role: 'user',
      content: '请根据以下面向客户的报价 JSON 撰写一封商务邮件草稿。报价信息：{{quotation}}\n请包含件号、数量、价格、交期、贸易术语和报价有效期，并给出下一步操作指引。',
    },
  ],
  config: { modelId: null, temperature: 0.7, maxTokens: 2048 },
  variables: ['quotation'],
  inputExample: {
    quotation: {
      customerName: 'Example Airlines',
      partNumber: 'BAC31GK0020',
      quantity: 2,
      unitPrice: 1200,
      totalPrice: 2400,
      validityDays: 15,
    },
  },
};

const businessChat: BuiltinAgentDefinition = {
  key: 'business_chat',
  name: '业务问答',
  type: 'BUSINESS_CHAT',
  description: '回答航材交易业务问题并在无法确认时明确说明。',
  prompts: [
    {
      role: 'system',
      content: '你是 AeroLink 航材交易平台的业务助手。你没有数据库、业务系统或外部工具访问权限，只能基于用户在当前消息中提供的信息回答。涉及审批、订单和邮件发送时只给出建议，不直接执行操作；不确定时明确说明需要人工核实。',
    },
    {
      role: 'user',
      content: '{{message}}',
    },
  ],
  config: { modelId: null, temperature: 0.7, maxTokens: 2048 },
  variables: ['message'],
  inputExample: { message: '这个 RFQ 目前处于什么状态？' },
};

export const BUILTIN_AGENTS: readonly BuiltinAgentDefinition[] = [
  rfqExtraction,
  quoteAnalysis,
  customerEmail,
  businessChat,
];

const BUILTIN_BY_KEY = new Map(BUILTIN_AGENTS.map((agent) => [agent.key, agent]));

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getBuiltinAgent(key: string): BuiltinAgentDefinition | undefined {
  const definition = BUILTIN_BY_KEY.get(key);
  return definition ? clone(definition) : undefined;
}

const promptMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().trim().min(1, '提示词内容不能为空').max(20_000, '提示词内容不能超过20000个字符'),
}).strict();

const agentConfigSchema = z.object({
  modelId: z.string().trim().min(1, '模型 ID 不能为空').nullable().optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(16_384).optional(),
}).strict();

export const agentPromptsSchema = z.array(promptMessageSchema)
  .min(1, '至少需要一条提示词')
  .max(20, '提示词最多支持20条')
  .superRefine((prompts, context) => {
    if (!prompts.some((prompt) => prompt.role === 'user')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '提示词至少需要一条 user 消息' });
    }
  });

export const agentConfigValidationSchema = agentConfigSchema;

export class AgentDraftValidationError extends Error {
  readonly details: Record<string, string[]>;

  constructor(details: Record<string, string[]>) {
    super('智能体草稿校验失败');
    this.name = 'AgentDraftValidationError';
    this.details = details;
  }
}

function zodDetails(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'root';
    (details[path] ||= []).push(issue.message);
  }
  return details;
}

const variablePattern = /\{\{\s*([^{}]+?)\s*\}\}/g;

function validateTemplateVariables(prompts: AgentPrompt[], allowedVariables?: readonly string[]) {
  if (!allowedVariables) return;
  const allowed = new Set(allowedVariables);
  const unknown = new Set<string>();
  for (const prompt of prompts) {
    for (const match of prompt.content.matchAll(variablePattern)) {
      const key = match[1].trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !allowed.has(key)) unknown.add(key);
    }
  }
  if (unknown.size > 0) {
    throw new AgentDraftValidationError({
      prompts: [`提示词包含未知模板变量：${Array.from(unknown).sort().join(', ')}`],
    });
  }
}

export function validateAgentDraft(
  prompts: unknown,
  config: unknown,
  builtinKey?: string | null,
): { prompts: AgentPrompt[]; config: AgentConfig } {
  const parsedPrompts = agentPromptsSchema.safeParse(prompts);
  const parsedConfig = agentConfigSchema.safeParse(config);
  const details: Record<string, string[]> = {};
  if (!parsedPrompts.success) Object.assign(details, zodDetails(parsedPrompts.error));
  if (!parsedConfig.success) Object.assign(details, zodDetails(parsedConfig.error));
  if (!parsedPrompts.success || !parsedConfig.success) throw new AgentDraftValidationError(details);

  const definition = builtinKey ? BUILTIN_BY_KEY.get(builtinKey) : undefined;
  validateTemplateVariables(parsedPrompts.data, definition?.variables);
  return {
    prompts: clone(parsedPrompts.data),
    config: clone(parsedConfig.data),
  };
}

type AgentRow = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  isActive: boolean;
  config: string;
  prompts: string;
  builtinKey: string | null;
  draftRevision: number;
  publishedVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type VersionRow = {
  id: string;
  agentId: string;
  version: number;
  prompts: string;
  config: string;
  createdBy: string | null;
  createdAt: Date;
};

interface AgentDelegate {
  findUnique(args: Record<string, unknown>): Promise<AgentRow | null>;
  create(args: Record<string, unknown>): Promise<AgentRow>;
  update(args: Record<string, unknown>): Promise<AgentRow>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

interface VersionDelegate {
  findUnique(args: Record<string, unknown>): Promise<VersionRow | null>;
  findMany(args: Record<string, unknown>): Promise<VersionRow[]>;
  create(args: Record<string, unknown>): Promise<VersionRow>;
}

export interface AgentRegistryClient {
  aIAgent: AgentDelegate;
  aIAgentVersion: VersionDelegate;
  $transaction?: <T>(callback: (tx: AgentRegistryClient) => Promise<T>) => Promise<T>;
}

const defaultClient = prisma as unknown as AgentRegistryClient;

async function inTransaction<T>(client: AgentRegistryClient, callback: (tx: AgentRegistryClient) => Promise<T>) {
  if (typeof client.$transaction === 'function') return client.$transaction(callback);
  return callback(client);
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002');
}

async function ensureBuiltinAgent(
  client: AgentRegistryClient,
  definition: BuiltinAgentDefinition,
) {
  const initialize = async (tx: AgentRegistryClient) => {
    const builtinId = `builtin-${definition.key}`;
    let agent = await tx.aIAgent.findUnique({ where: { builtinKey: definition.key } });
    if (!agent) {
      const rowWithBuiltinId = await tx.aIAgent.findUnique({ where: { id: builtinId } });
      if (rowWithBuiltinId) {
        // Never claim or rewrite an existing custom row with a reserved ID.
        return;
      }
      agent = await tx.aIAgent.create({
        data: {
          id: builtinId,
          name: definition.name,
          type: definition.type,
          description: definition.description,
          isActive: true,
          builtinKey: definition.key,
          config: JSON.stringify(definition.config),
          prompts: JSON.stringify(definition.prompts),
          draftRevision: 0,
          publishedVersion: 1,
        },
      });
      await tx.aIAgentVersion.create({
        data: {
          agentId: agent.id,
          version: 1,
          prompts: JSON.stringify(definition.prompts),
          config: JSON.stringify(definition.config),
          createdBy: null,
        },
      });
    }
    // A pre-existing row is deliberately left byte-for-byte unchanged. This
    // includes rows whose v1 snapshot is missing or whose published pointer is
    // invalid; execution will fail closed until an administrator repairs it.
  };

  try {
    await inTransaction(client, initialize);
  } catch (error) {
    // Two API processes may initialize the same key at once. PostgreSQL rolls
    // back the losing transaction after the unique conflict, so retry the
    // read-only existing-row path in a fresh transaction.
    if (!isUniqueConstraintError(error)) throw error;
    await inTransaction(client, initialize);
  }
}

/**
 * Add only absent built-in rows and their first immutable snapshot. Existing
 * names, prompts, config, activation state and versions are deliberately
 * preserved so initialization is safe to run on every process start.
 */
export async function ensureBuiltinAgents(client: AgentRegistryClient = defaultClient): Promise<void> {
  for (const definition of BUILTIN_AGENTS) {
    await ensureBuiltinAgent(client, definition);
  }
}

export function parseAgentJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
