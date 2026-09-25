import { describe, expect, it } from 'vitest';
import {
  AgentDraftValidationError,
  type AgentRegistryClient,
  BUILTIN_AGENTS,
  ensureBuiltinAgents,
  getBuiltinAgent,
  validateAgentDraft,
} from './aiAgentRegistry.js';

function registryDouble() {
  const agents = new Map<string, any>();
  const versions = new Map<string, any>();
  let agentCreates = 0;
  let versionCreates = 0;

  const findAgent = async ({ where }: any) => {
    if (where.id) return agents.get(where.id) ?? null;
    if (where.builtinKey) return Array.from(agents.values()).find((agent) => agent.builtinKey === where.builtinKey) ?? null;
    return null;
  };
  const client = {
    aIAgent: {
      findUnique: findAgent,
      create: async ({ data }: any) => {
        const row = { ...data, description: data.description ?? null, createdAt: new Date(), updatedAt: new Date() };
        agents.set(row.id, row);
        agentCreates += 1;
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = agents.get(where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = agents.get(where.id);
        if (!row || (where.draftRevision !== undefined && row.draftRevision !== where.draftRevision)) return { count: 0 };
        Object.assign(row, data);
        if (data.draftRevision?.increment) row.draftRevision += data.draftRevision.increment;
        return { count: 1 };
      },
    },
    aIAgentVersion: {
      findUnique: async ({ where }: any) => versions.get(`${where.agentId_version.agentId}:${where.agentId_version.version}`) ?? null,
      findMany: async ({ where, orderBy }: any) => Array.from(versions.values())
        .filter((version) => version.agentId === where.agentId)
        .sort((a, b) => (orderBy?.version === 'desc' ? b.version - a.version : a.version - b.version)),
      create: async ({ data }: any) => {
        const row = { id: `${data.agentId}:${data.version}`, ...data, createdAt: new Date() };
        versions.set(`${data.agentId}:${data.version}`, row);
        versionCreates += 1;
        return row;
      },
    },
    $transaction: async (callback: any) => callback(client),
  } as unknown as AgentRegistryClient;

  return { client, agents, versions, counts: () => ({ agentCreates, versionCreates }) };
}

describe('AI agent registry', () => {
  it('exports the five built-in workflows with the agreed input variables', () => {
    expect(BUILTIN_AGENTS.map((agent) => agent.key)).toEqual([
      'rfq_extraction',
      'supplier_quote_extraction',
      'quote_analysis',
      'customer_email',
      'business_chat',
    ]);
    expect(BUILTIN_AGENTS.map((agent) => agent.variables)).toEqual([
      ['subject', 'body'],
      ['subject', 'body', 'inquiryContext'],
      ['rfqDetails', 'supplierQuotes'],
      ['quotation'],
      ['message'],
    ]);
    const quoteExtraction = getBuiltinAgent('supplier_quote_extraction');
    expect(quoteExtraction?.prompts[0].content).toContain('不可信数据');
    expect(quoteExtraction?.prompts[0].content).toContain('绝不声称或尝试创建、修改、确认报价');
    expect(quoteExtraction?.prompts[1].content).toContain('taxIncluded');
    expect(quoteExtraction?.prompts[1].content).toContain('freightIncluded');
    expect(quoteExtraction?.prompts[1].content).toContain('incoterm');
    expect(quoteExtraction?.prompts[1].content).toContain('否则为 null');
    expect(getBuiltinAgent('missing')).toBeUndefined();
  });

  it('rejects missing user prompts and unknown built-in template variables', () => {
    expect(() => validateAgentDraft(
      [{ role: 'system', content: 'only system' }],
      {},
    )).toThrow(AgentDraftValidationError);
    expect(() => validateAgentDraft(
      [{ role: 'user', content: '{{body}} {{unexpected}}' }],
      {},
      'rfq_extraction',
    )).toThrow(/草稿校验失败/);
  });

  it('initializes missing rows and v1 snapshots idempotently without overwriting edits', async () => {
    const double = registryDouble();
    await ensureBuiltinAgents(double.client);
    expect(double.agents.size).toBe(5);
    expect(double.versions.size).toBe(5);
    expect(double.counts()).toEqual({ agentCreates: 5, versionCreates: 5 });

    const rfq = double.agents.get('builtin-rfq_extraction');
    rfq.prompts = JSON.stringify([{ role: 'user', content: 'custom draft' }]);
    rfq.config = JSON.stringify({ modelId: 'custom-model', temperature: 0.4 });
    rfq.publishedVersion = null;
    await ensureBuiltinAgents(double.client);
    expect(double.counts()).toEqual({ agentCreates: 5, versionCreates: 5 });
    expect(JSON.parse(double.agents.get('builtin-rfq_extraction').prompts)).toEqual([{ role: 'user', content: 'custom draft' }]);
    expect(JSON.parse(double.agents.get('builtin-rfq_extraction').config)).toEqual({ modelId: 'custom-model', temperature: 0.4 });
    expect(double.agents.get('builtin-rfq_extraction').publishedVersion).toBeNull();
  });

  it('leaves an existing built-in row untouched when its v1 snapshot is missing', async () => {
    const double = registryDouble();
    double.agents.set('existing-rfq', {
      id: 'existing-rfq', name: 'renamed', type: 'RFQ_EXTRACTION', description: 'owned', isActive: true,
      builtinKey: 'rfq_extraction', draftRevision: 7, publishedVersion: null,
      prompts: JSON.stringify([{ role: 'user', content: 'owner draft' }]),
      config: JSON.stringify({ modelId: 'owner-model' }),
      createdAt: new Date(), updatedAt: new Date(),
    });
    await ensureBuiltinAgents(double.client);
    expect(double.agents.get('existing-rfq').publishedVersion).toBeNull();
    expect(double.agents.get('existing-rfq').draftRevision).toBe(7);
    expect(double.versions.has('existing-rfq:1')).toBe(false);
  });
});
