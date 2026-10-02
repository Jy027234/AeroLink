import { createHash } from 'node:crypto';
import prisma from './prisma.js';
import { type AgentRegistryClient, getBuiltinAgent } from './aiAgentRegistry.js';

export function promptSha256(prompts: string) {
  return createHash('sha256').update(prompts).digest('hex');
}

/** Explicit release operation, never called by normal process initialization. */
export async function upgradeSupplierQuoteAgent(
  options: { apply: boolean; expectedVersion: number; expectedPromptsSha256: string },
  client: AgentRegistryClient = prisma as unknown as AgentRegistryClient,
) {
  if (!Number.isInteger(options.expectedVersion) || options.expectedVersion < 1
    || !/^[a-f0-9]{64}$/.test(options.expectedPromptsSha256)) throw new Error('Expected version/hash are required');
  const run = async (tx: AgentRegistryClient) => {
    const agent = await tx.aIAgent.findUnique({ where: { builtinKey: 'supplier_quote_extraction' } });
    if (!agent?.isActive || agent.publishedVersion !== options.expectedVersion) {
      throw new Error('Extraction agent is missing, inactive or no longer at the reviewed version');
    }
    const previous = await tx.aIAgentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.publishedVersion } },
    });
    if (!previous || promptSha256(previous.prompts) !== options.expectedPromptsSha256) {
      throw new Error('Published prompt differs from the reviewed hash; no upgrade performed');
    }
    // Do not clobber a user's un-published prompt or model/configuration edits.
    if (agent.prompts !== previous.prompts || agent.config !== previous.config) {
      throw new Error('Unpublished customization exists; use the agent editor to merge and publish');
    }
    const prompts = JSON.stringify(getBuiltinAgent('supplier_quote_extraction')!.prompts);
    const versions = await tx.aIAgentVersion.findMany({ where: { agentId: agent.id }, orderBy: { version: 'desc' } });
    const nextVersion = Math.max(...versions.map(version => version.version), previous.version) + 1;
    const result = { agentId: agent.id, previousVersion: previous.version,
      previousPromptsSha256: options.expectedPromptsSha256, nextVersion,
      nextPromptsSha256: promptSha256(prompts), applied: false, unchanged: previous.prompts === prompts };
    if (!options.apply || result.unchanged) return result;
    await tx.aIAgentVersion.create({ data: {
      agentId: agent.id, version: nextVersion, prompts, config: previous.config, createdBy: null,
    } });
    const updated = await tx.aIAgent.updateMany({
      where: { id: agent.id, publishedVersion: previous.version, draftRevision: agent.draftRevision,
        prompts: agent.prompts, config: agent.config, isActive: true },
      data: { prompts, publishedVersion: nextVersion, draftRevision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error('Agent changed during upgrade; transaction must roll back');
    return { ...result, applied: true };
  };
  if (!client.$transaction) throw new Error('Agent upgrade requires a transactional client');
  return client.$transaction(run);
}
