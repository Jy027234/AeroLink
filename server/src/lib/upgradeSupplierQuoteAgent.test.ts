import { describe, expect, it } from 'vitest';
import { type AgentRegistryClient, getBuiltinAgent } from './aiAgentRegistry.js';
import { promptSha256, upgradeSupplierQuoteAgent } from './upgradeSupplierQuoteAgent.js';

function fixture() {
  const legacyPrompts = JSON.stringify([{ role: 'user', content: 'Old supplier quote prompt {{body}}' }]);
  const config = JSON.stringify({ modelId: 'operator-model', temperature: 0.2, maxTokens: 4096 });
  let state = { agent: { id: 'builtin-supplier_quote_extraction', builtinKey: 'supplier_quote_extraction',
    isActive: true, publishedVersion: 1, draftRevision: 3, prompts: legacyPrompts, config },
    versions: [{ agentId: 'builtin-supplier_quote_extraction', version: 1, prompts: legacyPrompts, config }] };
  let conflict = false;
  const client = { $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
    const copy = structuredClone(state);
    const tx = {
      aIAgent: {
        findUnique: async () => copy.agent,
        updateMany: async () => conflict ? { count: 0 } : { count: 1 },
      },
      aIAgentVersion: {
        findUnique: async ({ where }: { where: { agentId_version: { version: number } } }) =>
          copy.versions.find(version => version.version === where.agentId_version.version) ?? null,
        findMany: async () => copy.versions,
        create: async ({ data }: { data: typeof copy.versions[number] }) => { copy.versions.push(data); return data; },
      },
    };
    tx.aIAgent.updateMany = async (...args: unknown[]) => {
      if (conflict) return { count: 0 };
      const { data } = args[0] as { data: { prompts: string; publishedVersion: number } };
      copy.agent.prompts = data.prompts;
      copy.agent.publishedVersion = data.publishedVersion;
      copy.agent.draftRevision++;
      return { count: 1 };
    };
    const result = await callback(tx);
    state = copy;
    return result;
  } } as unknown as AgentRegistryClient;
  return { client, state: () => state, setConflict: () => { conflict = true; },
    options: { apply: true, expectedVersion: 1, expectedPromptsSha256: promptSha256(legacyPrompts) } };
}

describe('explicit supplier extraction prompt upgrade', () => {
  it('previews without writing any version or pointer', async () => {
    const f = fixture();
    expect(await upgradeSupplierQuoteAgent({ ...f.options, apply: false }, f.client))
      .toMatchObject({ applied: false, previousVersion: 1, nextVersion: 2 });
    expect(f.state().versions).toHaveLength(1);
    expect(f.state().agent.publishedVersion).toBe(1);
  });
  it('publishes a new immutable snapshot, retaining old prompt and configured model', async () => {
    const f = fixture();
    const old = structuredClone(f.state());
    expect(await upgradeSupplierQuoteAgent(f.options, f.client)).toMatchObject({ applied: true, nextVersion: 2 });
    expect(f.state().versions[0]).toEqual(old.versions[0]);
    expect(f.state().versions[1].prompts).toBe(JSON.stringify(getBuiltinAgent('supplier_quote_extraction')!.prompts));
    expect(f.state().agent.config).toBe(old.agent.config);
    expect(f.state().versions[1].config).toBe(old.agent.config);
    expect(f.state().agent.publishedVersion).toBe(2);
    await expect(upgradeSupplierQuoteAgent(f.options, f.client)).rejects.toThrow('reviewed version');
    expect(f.state().versions).toHaveLength(2);
  });
  it('does not overwrite unpublished operator changes or an unreviewed published version', async () => {
    const f = fixture();
    await expect(upgradeSupplierQuoteAgent({ ...f.options, expectedPromptsSha256: '0'.repeat(64) }, f.client))
      .rejects.toThrow('reviewed hash');
    f.state().agent.prompts = 'operator custom draft';
    await expect(upgradeSupplierQuoteAgent(f.options, f.client)).rejects.toThrow('Unpublished customization');
    expect(f.state().versions).toHaveLength(1);
  });
  it('requires transactional support and rolls back on concurrent edits', async () => {
    const f = fixture();
    f.setConflict();
    await expect(upgradeSupplierQuoteAgent(f.options, f.client)).rejects.toThrow('roll back');
    expect(f.state().versions).toHaveLength(1);
    expect(f.state().agent.publishedVersion).toBe(1);
    await expect(upgradeSupplierQuoteAgent(f.options, {} as AgentRegistryClient)).rejects.toThrow('transactional');
  });
});
