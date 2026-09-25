import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ executeBuiltinAgent: vi.fn() }));
vi.mock('./aiAgentExecution.js', () => ({ executeBuiltinAgent: mocks.executeBuiltinAgent }));

import { extractSupplierQuoteEmail } from './aiService.js';

beforeEach(() => vi.resetAllMocks());

describe('supplier quote extraction service', () => {
  it('runs the dedicated built-in agent and returns only validated candidate data plus AI metadata', async () => {
    mocks.executeBuiltinAgent.mockResolvedValue({
      output: JSON.stringify({ items: [{ partNumber: 'PN-1', evidenceText: 'PN-1 USD 50 each' }] }),
      model: 'fixture-model',
      promptVersion: 3,
      agentId: 'builtin-supplier_quote_extraction',
      latency: 10,
    });
    const inquiryContext = { items: [{ rfqLineId: 'line-1', partNumber: 'PN-1', quantity: 2 }] };

    await expect(extractSupplierQuoteEmail('Supplier quote', 'PN-1 USD 50 each', inquiryContext, {
      actorId: 'user-1', action: 'sourcing.extract-supplier-quote',
    })).resolves.toEqual({
      items: [{
        partNumber: 'PN-1', evidenceText: 'PN-1 USD 50 each',
        taxIncluded: null, freightIncluded: null, incoterm: null,
      }],
      ai: { agentId: 'builtin-supplier_quote_extraction', promptVersion: 3, model: 'fixture-model' },
    });
    expect(mocks.executeBuiltinAgent).toHaveBeenCalledWith('supplier_quote_extraction', {
      subject: 'Supplier quote', body: 'PN-1 USD 50 each', inquiryContext,
    }, { actorId: 'user-1', action: 'sourcing.extract-supplier-quote' });
  });

  it('accepts evidence located in the email subject or whitespace-normalized body', async () => {
    mocks.executeBuiltinAgent.mockResolvedValue({
      output: JSON.stringify({ items: [
        { partNumber: 'PN-SUBJECT', taxIncluded: true, freightIncluded: false, incoterm: 'fca', evidenceText: 'PN-SUBJECT USD 10 each, tax included, freight excluded, FCA' },
        { partNumber: 'PN-BODY', evidenceText: 'PN-BODY at USD 20 each' },
      ] }),
      model: 'fixture-model', promptVersion: 1, agentId: 'builtin-supplier_quote_extraction', latency: 10,
    });

    const result = await extractSupplierQuoteEmail(
      'PN-SUBJECT USD 10 each, tax included, freight excluded, FCA',
      'We can offer PN-BODY at\n\tUSD 20 each.',
      {},
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ taxIncluded: true, freightIncluded: false, incoterm: 'FCA' });
    expect(result.items[1]).toMatchObject({ taxIncluded: null, freightIncluded: null, incoterm: null });
  });

  it('rejects evidence that cannot be located in the source email', async () => {
    mocks.executeBuiltinAgent.mockResolvedValue({
      output: '{"items":[{"partNumber":"PN-1","unitPrice":500,"currency":"USD","evidenceText":"PN-1 USD 500 each"}]}',
      model: 'fixture-model', promptVersion: 1, agentId: 'builtin-supplier_quote_extraction', latency: 10,
    });
    await expect(extractSupplierQuoteEmail('Supplier quote', 'PN-1 USD 50 each', {}))
      .rejects.toThrow('报价依据无法在原邮件中定位');
  });
});
