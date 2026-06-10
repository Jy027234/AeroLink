import OpenAI from 'openai';
import { logger } from './logger.js';
import prisma from './prisma.js';

interface AIModelConfig {
  id: string;
  modelId: string;
  apiKey?: string | null;
  baseUrl?: string | null;
}

export interface AICompletionOptions {
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AICompletionResult {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latency: number;
}

async function getDefaultModel() {
  const model = await prisma.aIModel.findFirst({
    where: { isActive: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  return model;
}

async function getModelById(id: string) {
  return prisma.aIModel.findUnique({ where: { id } });
}

function createOpenAIClient(model: AIModelConfig): OpenAI {
  const isDeepSeek = model.baseUrl?.includes('deepseek') || model.modelId?.includes('deepseek');
  const apiKey = model.apiKey
    || (isDeepSeek ? process.env.DEEPSEEK_API_KEY : undefined)
    || process.env.OPENAI_API_KEY
    || 'sk-demo';

  const config: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey,
  };
  if (model.baseUrl) {
    config.baseURL = model.baseUrl;
  }
  return new OpenAI(config);
}

export async function generateCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: AICompletionOptions = {}
): Promise<AICompletionResult> {
  const start = Date.now();

  const model = options.modelId
    ? await getModelById(options.modelId)
    : await getDefaultModel();

  if (!model) {
    throw new Error('未找到可用的AI模型，请先在设置中配置模型');
  }

  const client = createOpenAIClient(model);

  try {
    const response = await client.chat.completions.create({
      model: model.modelId,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
    });

    const latency = Date.now() - start;
    const content = response.choices[0]?.message?.content || '';

    return {
      content,
      model: model.modelId,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      latency,
    };
  } catch (error) {
    logger.error({ error, modelId: model.id }, 'AI completion failed');
    throw new Error('AI调用失败: ' + (error instanceof Error ? error.message : '未知错误'));
  }
}

export async function classifyRFQEmail(subject: string, body: string): Promise<{
  type: string;
  partNumbers: string[];
  quantities: number[];
  urgency: string;
  aircraftType?: string;
}> {
  const prompt = `你是一个航材交易平台的AI助手。请分析以下邮件内容，提取关键信息并以JSON格式返回。

邮件主题: ${subject}
邮件内容:
${body}

请返回以下格式的JSON（不要包含markdown代码块标记）：
{
  "type": "AOG|STANDARD|INQUIRY|SPAM",
  "partNumbers": ["件号1", "件号2"],
  "quantities": [数量1, 数量2],
  "urgency": "AOG|URGENT|STANDARD",
  "aircraftType": "机型（如Boeing 737-800）"
}

规则：
- type: 如果包含AOG/紧急/停场/停飞等关键词则为AOG；如果包含询价/报价/RFQ则为INQUIRY；如果是广告/推广则为SPAM；否则为STANDARD
- partNumbers: 提取所有件号（P/N, Part Number, 件号后面的值）
- quantities: 提取对应的数量
- urgency: AOG需求为AOG，明确提到紧急为URGENT，否则为STANDARD
- aircraftType: 提取机型信息`;

  try {
    const result = await generateCompletion(
      [
        {
          role: 'system',
          content: '你是一个专业的航材交易AI助手，擅长从邮件中提取航材需求信息。只返回纯JSON，不要包含任何解释文字。',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1, maxTokens: 1024 }
    );

    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI返回格式不正确');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      type: parsed.type || 'STANDARD',
      partNumbers: parsed.partNumbers || [],
      quantities: parsed.quantities || [],
      urgency: parsed.urgency || 'STANDARD',
      aircraftType: parsed.aircraftType,
    };
  } catch (error) {
    logger.warn({ error, subject }, 'AI RFQ classification failed, falling back to rule-based');
    return fallbackClassifyRFQ(subject, body);
  }
}

function fallbackClassifyRFQ(subject: string, body: string) {
  const text = `${subject} ${body}`.toLowerCase();

  let type = 'STANDARD';
  if (/aog|紧急|urgent|grounded|停场|停飞/.test(text)) type = 'AOG';
  else if (/询价|quote|quotation|rfq|request for quote|price|报价/.test(text)) type = 'INQUIRY';
  else if (/广告|promotion|unsubscribe|营销|推广|spam/.test(text)) type = 'SPAM';

  let urgency = 'STANDARD';
  if (/aog|紧急|urgent|grounded|停场|停飞|立即|asap/.test(text)) urgency = 'AOG';
  else if (/urgent|紧急|尽快/.test(text)) urgency = 'URGENT';

  const partNumberMatches = text.match(/(?:p\/n|part\s*number|件号)[\s:：]*([A-Z0-9-]+)/gi);
  const partNumbers = partNumberMatches
    ? partNumberMatches.map((m) => m.replace(/(?:p\/n|part\s*number|件号)[\s:：]*/i, '').trim())
    : [];

  const quantityMatches = text.match(/(?:qty|quantity|数量)[\s:：]*(\d+)/gi);
  const quantities = quantityMatches
    ? quantityMatches.map((m) => parseInt(m.replace(/\D/g, ''), 10))
    : [];

  const aircraftMatch = text.match(/(?:boeing|airbus|机型)[\s:：]*([A-Z0-9-]+)/i);
  const aircraftType = aircraftMatch ? aircraftMatch[1] : undefined;

  return { type, partNumbers, quantities, urgency, aircraftType };
}

export async function generateQuoteAnalysis(
  rfqDetails: string,
  supplierQuotes: string
): Promise<string> {
  const prompt = `作为航材销售专家，请分析以下RFQ和供应商报价，给出报价建议。

RFQ详情:
${rfqDetails}

供应商报价:
${supplierQuotes}

请给出：
1. 市场分析（该件号的市场供需情况）
2. 定价建议（建议的报价区间和理由）
3. 风险提示（需要注意的问题）
4. 竞争策略建议`;

  const result = await generateCompletion(
    [
      {
        role: 'system',
        content: '你是航材交易领域的资深销售专家，擅长市场分析和定价策略。请用中文回答，条理清晰。',
      },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.7, maxTokens: 2048 }
  );

  return result.content;
}

export async function generateCustomerEmail(
  context: {
    customerName: string;
    partNumber: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    incoterm?: string;
    incotermLocation?: string;
    leadTimeDays?: number;
    validityDays: number;
  }
): Promise<string> {
  const prompt = `请为以下报价生成一封专业的商务邮件：

客户: ${context.customerName}
件号: ${context.partNumber}
数量: ${context.quantity}
单价: $${context.unitPrice}
总价: $${context.totalPrice}
贸易术语: ${context.incoterm || '-'} ${context.incotermLocation || ''}
交货期: ${context.leadTimeDays || '-'} 天
报价有效期: ${context.validityDays}天

要求：
1. 语气专业、礼貌
2. 包含件号、数量、价格、交货期等关键信息
3. 说明报价有效期
4. 提供下一步操作指引`;

  const result = await generateCompletion(
    [
      {
        role: 'system',
        content: '你是航材交易平台的商务邮件撰写专家，擅长撰写专业、得体的商务邮件。',
      },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.7, maxTokens: 2048 }
  );

  return result.content;
}

export async function logAgentAction(
  agentId: string,
  action: string,
  input: string,
  output: string,
  status: string = 'SUCCESS',
  error?: string,
  duration?: number
) {
  try {
    await prisma.agentLog.create({
      data: {
        agentId,
        action,
        input: input.slice(0, 4000),
        output: output.slice(0, 4000),
        status,
        error: error?.slice(0, 1000),
        duration,
      },
    });
  } catch (e) {
    logger.error({ e, agentId }, 'Failed to log agent action');
  }
}
