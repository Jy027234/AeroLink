import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  agent: vi.fn(), version: vi.fn(), createLog: vi.fn(), updateLog: vi.fn(), completion: vi.fn(),
}));
vi.mock('./prisma.js', () => ({ default: {
  aIAgent: { findUnique: mocks.agent }, aIAgentVersion: { findUnique: mocks.version },
  agentLog: { create: mocks.createLog, update: mocks.updateLog },
} }));
vi.mock('./aiCompletion.js', () => ({ generateCompletion: mocks.completion }));
import { executeAgent, renderAgentPrompts } from './aiAgentExecution.js';
import { AppError } from '../middleware/errorHandler.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent.mockResolvedValue({ id: 'agent-1', isActive: true, publishedVersion: 2,
    prompts: JSON.stringify([{ role: 'user', content: 'UNPUBLISHED DRAFT' }]) });
  mocks.version.mockResolvedValue({ version: 2,
    config: JSON.stringify({ modelId: 'model-2', temperature: 0.2, maxTokens: 900 }),
    prompts: JSON.stringify([{ role: 'system', content: 'Published instructions' }, { role: 'user', content: '{{message}}' }]),
  });
  mocks.createLog.mockResolvedValue({ id: 'log-1' });
  mocks.updateLog.mockResolvedValue({});
  mocks.completion.mockResolvedValue({ content: 'Advice', model: 'actual-provider-model', modelConfigId: 'model-2', latency: 25 });
});

describe('published agent execution', () => {
  it('uses only the immutable published snapshot, model and authenticated attribution', async () => {
    const result = await executeAgent('agent-1', { message: 'Private business input' }, { actorId: 'real-user', action: 'business.chat' });
    expect(mocks.version).toHaveBeenCalledWith({ where: { agentId_version: { agentId: 'agent-1', version: 2 } } });
    expect(mocks.completion).toHaveBeenCalledWith([
      { role: 'system', content: 'Published instructions' }, { role: 'user', content: 'Private business input' },
    ], { modelId: 'model-2', temperature: 0.2, maxTokens: 900 });
    expect(result).toEqual({ output: 'Advice', model: 'actual-provider-model', latency: 25, agentId: 'agent-1', promptVersion: 2 });
    const initial = mocks.createLog.mock.calls[0][0].data;
    expect(initial.action).toBe('business.chat');
    expect(JSON.parse(initial.input)).toMatchObject({ actorId: 'real-user', promptVersion: 2 });
    expect(initial.input).not.toContain('Private business input');
    const finished = mocks.updateLog.mock.calls[0][0].data;
    expect(finished.status).toBe('SUCCESS');
    expect(JSON.parse(finished.output)).toMatchObject({ promptVersion: 2, model: 'actual-provider-model', modelConfigId: 'model-2' });
    expect(finished.output).not.toContain('Advice');
  });

  it.each([
    [null, '智能体不存在'],
    [{ isActive: false }, '智能体已停用'],
    [{ isActive: true, publishedVersion: null }, '尚未发布'],
  ])('does not call any provider for unavailable agents', async (agent, message) => {
    mocks.agent.mockResolvedValue(agent);
    await expect(executeAgent('agent-1', {})).rejects.toThrow(message as string);
    expect(mocks.completion).not.toHaveBeenCalled();
  });

  it('fails closed when the published snapshot is missing', async () => {
    mocks.version.mockResolvedValue(null);
    await expect(executeAgent('agent-1', {})).rejects.toThrow('版本缺失');
    expect(mocks.completion).not.toHaveBeenCalled();
  });

  it('does not call the provider with missing template variables', async () => {
    await expect(executeAgent('agent-1', {})).rejects.toThrow('缺少提示词变量');
    expect(mocks.completion).not.toHaveBeenCalled();
  });

  it('preserves safe configuration errors and logs a failed invocation', async () => {
    mocks.completion.mockRejectedValue(new AppError('请配置默认模型', 409, 'STATE_CONFLICT'));
    await expect(executeAgent('agent-1', { message: 'hello' })).rejects.toMatchObject({ statusCode: 409, message: '请配置默认模型' });
    expect(mocks.updateLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR', error: '请配置默认模型' }) }));
  });

  it('never exposes raw provider exceptions or pretends to succeed', async () => {
    mocks.completion.mockRejectedValue(new Error('Authorization: sk-private-business-data'));
    await expect(executeAgent('agent-1', { message: 'hello' })).rejects.toThrow('智能体运行失败');
    expect(JSON.stringify(mocks.updateLog.mock.calls)).not.toContain('sk-private');
  });

  it('rejects malformed extraction output and records failure instead of rule fallback success', async () => {
    mocks.agent.mockResolvedValue({ isActive: true, publishedVersion: 2, builtinKey: 'rfq_extraction' });
    mocks.completion.mockResolvedValue({ content: '{"partNumbers":["PN-1"],"quantities":[-2]}', model: 'model-2' });
    await expect(executeAgent('agent-1', { message: 'hello' })).rejects.toThrow('需求提取结果不符合格式');
    expect(mocks.updateLog.mock.calls[0][0].data.status).toBe('ERROR');
  });

  it('does one-pass variable substitution without interpreting source documents as templates', () => {
    expect(renderAgentPrompts([{ role: 'user', content: 'Mail: {{body}}' }], { body: '{{secret}}', secret: 'never-insert' }))
      .toEqual([{ role: 'user', content: 'Mail: {{secret}}' }]);
  });
  it('rejects inherited variables and oversized inputs', () => {
    expect(() => renderAgentPrompts([{ role: 'user', content: '{{toString}}' }], {})).toThrow('缺少');
    expect(() => renderAgentPrompts([{ role: 'user', content: '{{body}}' }], { body: 'x'.repeat(100001) })).toThrow('过大');
  });
  it('rejects corrupted published prompts that lack a user message or carry unknown message fields', () => {
    expect(() => renderAgentPrompts([{ role: 'system', content: 'no input message' }], {})).toThrow('提示词格式无效');
    expect(() => renderAgentPrompts([{ role: 'user', content: 'input', tool_calls: [] }], {})).toThrow('提示词格式无效');
  });
});
