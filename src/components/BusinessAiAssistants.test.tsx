import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ email: vi.fn(), extract: vi.fn(), can: vi.fn() }));
vi.mock('@/api/client', () => ({ aiApi: { generateQuotationEmail: mocks.email, parseEmailById: mocks.extract } }));
vi.mock('@/store', () => ({ useCapabilityStore: (selector: (state: { can: typeof mocks.can }) => unknown) => selector({ can: mocks.can }) }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));
import { QuotationEmailAssistant, RfqExtractionAssistant } from './BusinessAiAssistants';
const ai = { agentId: 'agent-1', promptVersion: 2, model: 'test-model' };
beforeEach(() => { vi.stubGlobal('React', React); vi.clearAllMocks(); mocks.can.mockReturnValue(true); });
afterEach(() => cleanup());
describe('reviewable business AI suggestions', () => {
  it('does not replace an edited email until the user explicitly applies the generated draft', async () => {
    mocks.email.mockResolvedValue({ email: 'Generated draft', ai }); const apply = vi.fn();
    render(<QuotationEmailAssistant quotationId="quote-1" onApply={apply} />);
    fireEvent.click(screen.getByRole('button', { name: '生成 AI 邮件草稿' }));
    await screen.findByText('Generated draft'); expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '采用草稿并替换邮件内容' }));
    expect(apply).toHaveBeenCalledWith('Generated draft');
  });
  it('keeps the user draft untouched and shows configuration failures', async () => {
    mocks.email.mockRejectedValue(new Error('请配置默认模型')); const apply = vi.fn();
    render(<QuotationEmailAssistant quotationId="quote-1" onApply={apply} />);
    fireEvent.click(screen.getByRole('button', { name: '生成 AI 邮件草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请配置默认模型'); expect(apply).not.toHaveBeenCalled();
  });
  it('discards late responses when the selected quotation changes', async () => {
    let resolve!: (value: { email: string; ai: typeof ai }) => void;
    mocks.email.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { rerender } = render(<QuotationEmailAssistant quotationId="old" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '生成 AI 邮件草稿' }));
    rerender(<QuotationEmailAssistant quotationId="new" onApply={vi.fn()} />);
    await act(async () => { resolve({ email: 'Old quote draft', ai }); });
    expect(screen.queryByText('Old quote draft')).not.toBeInTheDocument();
  });
  it('shows all extracted lines and requires explicit selection', async () => {
    const extracted = { partNumbers: ['PN-1', 'PN-2'], quantities: [2, 3], urgency: 'STANDARD', type: 'STANDARD', ai };
    mocks.extract.mockResolvedValue(extracted); const apply = vi.fn();
    render(<RfqExtractionAssistant emailId="email-1" onApply={apply} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI 提取需求建议' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: '填入待确认卡片' })).toHaveLength(2));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: '填入待确认卡片' })[1]);
    expect(apply).toHaveBeenCalledWith(extracted, 1);
  });
});
