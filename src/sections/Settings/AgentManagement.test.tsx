import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import type { ClientAIAgent, ClientAIModel } from '@/api/client';
import { AgentManagement } from './AgentManagement';
import { AgentCallLogs } from './AgentCallLogs';
import { AgentEditor } from './AgentEditor';
import { ModelManagement } from './ModelManagement';

const mocks = vi.hoisted(() => ({
  agentApi: {
    getAll: vi.fn(),
    update: vi.fn(),
    getVersions: vi.fn(),
    publish: vi.fn(),
    restore: vi.fn(),
    test: vi.fn(),
    getLogs: vi.fn(),
  },
  modelApi: {
    getAll: vi.fn(),
    update: vi.fn(),
    setDefault: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    test: vi.fn(),
  },
}));

vi.mock('@/api/client', () => ({
  agentApi: mocks.agentApi,
  modelApi: mocks.modelApi,
}));

const model: ClientAIModel = {
  id: 'model-1',
  name: 'Operations OpenAI',
  provider: 'openai',
  modelId: 'gpt-4o-mini',
  hasApiKey: true,
  baseUrl: null,
  isActive: true,
  isDefault: true,
  config: {},
  capabilities: ['chat'],
};

const agent: ClientAIAgent = {
  id: 'builtin-business-chat',
  name: 'Business Chat',
  type: 'CHAT',
  description: '旧描述不应覆盖目录说明',
  isActive: true,
  config: { modelId: model.id, temperature: 0.3, maxTokens: 1024 },
  prompts: [
    { role: 'system', content: 'You are an aviation assistant.' },
    { role: 'user', content: '{{message}}' },
  ],
  builtinKey: 'business_chat',
  draftRevision: 2,
  publishedVersion: null,
  workflow: {
    label: '业务问答',
    description: '回答航材交易业务问题',
    variables: ['message'],
    inputExample: { message: '如何查询报价？' },
  },
};

function renderPage() {
  return render(<I18nProvider><AgentManagement /></I18nProvider>);
}

describe('AgentManagement', () => {
  beforeEach(() => {
    mocks.agentApi.getAll.mockResolvedValue([agent]);
    mocks.modelApi.getAll.mockResolvedValue([model]);
    mocks.agentApi.getVersions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders built-in workflow copy and clear unpublished/model states', async () => {
    renderPage();

    expect(await screen.findByText('业务问答')).toBeTruthy();
    expect(screen.getByText('回答航材交易业务问题')).toBeTruthy();
    expect(screen.getByText('未发布')).toBeTruthy();
    expect(screen.getByText('{{message}}')).toBeTruthy();
  });

  it('keeps request errors visible instead of swallowing initial load failures', async () => {
    mocks.agentApi.getAll.mockRejectedValue(new Error('agents unavailable'));

    renderPage();

    expect(await screen.findByText('agents unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('sends expectedRevision when toggling an agent', async () => {
    mocks.agentApi.update.mockResolvedValue({ ...agent, isActive: false, draftRevision: 3 });

    renderPage();
    await screen.findByText('业务问答');
    const toggle = screen.getByRole('switch', { name: '切换 业务问答' });
    toggle.click();

    await waitFor(() => expect(mocks.agentApi.update).toHaveBeenCalledWith('builtin-business-chat', {
      expectedRevision: 2,
      isActive: false,
    }));
  });

  it('tests the published snapshot and keeps the test available with a dirty draft', async () => {
    const publishedAgent: ClientAIAgent = {
      ...agent,
      config: { modelId: 'deleted-draft-model', temperature: 0.9 },
      publishedVersion: 1,
    };
    mocks.agentApi.getAll.mockResolvedValue([publishedAgent]);
    mocks.agentApi.getVersions.mockResolvedValue([{
      version: 1,
      prompts: agent.prompts,
      config: { temperature: 0.2 },
      createdBy: 'admin-1',
      createdAt: '2026-09-11T01:00:00.000Z',
    }]);
    mocks.agentApi.test.mockResolvedValue({ output: 'published output', model: model.modelId, latency: 12, promptVersion: 1, agentId: publishedAgent.id });

    renderPage();
    await screen.findByText('业务问答');
    fireEvent.click(screen.getByRole('button', { name: '编辑配置' }));
    expect(await screen.findByText('版本历史')).toBeTruthy();

    await waitFor(() => expect(screen.getByRole('button', { name: '试运行' }).getAttribute('disabled')).toBeNull());
    fireEvent.change(screen.getByLabelText('第 1 条提示词内容'), { target: { value: 'changed draft' } });
    expect(screen.getByText('当前有未保存草稿；本次试运行仍使用已发布版本。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '试运行' }));

    await waitFor(() => expect(mocks.agentApi.test).toHaveBeenCalledWith(publishedAgent.id, { message: '如何查询报价？' }));
    expect(await screen.findByText('published output')).toBeTruthy();
  });

  it('renders server log metadata without rendering raw business payloads', async () => {
    mocks.agentApi.getLogs.mockResolvedValue([{
      id: 'log-1',
      agentId: agent.id,
      action: 'test',
      input: JSON.stringify({ actorId: 'user-1', promptVersion: 3, inputHash: 'input-hash' }),
      output: JSON.stringify({ model: 'gpt-4o-mini', promptVersion: 3, outputHash: 'output-hash' }),
      status: 'SUCCESS',
      duration: 42,
      createdAt: '2026-09-11T01:00:00.000Z',
    }]);

    render(<I18nProvider><AgentCallLogs agents={[agent]} tx={(zh) => zh} locale="zh-CN" /></I18nProvider>);

    expect(await screen.findByText(/user-1/)).toBeTruthy();
    expect(screen.getByText(/v3/)).toBeTruthy();
    expect(screen.getByText(/gpt-4o-mini/)).toBeTruthy();
    expect(screen.getByText(/42 ms/)).toBeTruthy();
    expect(screen.queryByText('input-hash')).toBeNull();
    expect(screen.queryByText('output-hash')).toBeNull();
  });

  it('tests a model connection with a real request and clears the result when editing', async () => {
    let resolveTest: (value: { status: 'ok'; message: string; latency: number; response: string }) => void = () => undefined;
    mocks.modelApi.test.mockImplementation(() => new Promise((resolve) => { resolveTest = resolve; }));
    const onModelsChange = vi.fn();

    render(<I18nProvider><ModelManagement models={[model]} onModelsChange={onModelsChange} tx={(zh) => zh} /></I18nProvider>);

    const testButton = screen.getByRole('button', { name: '测试连接' });
    fireEvent.click(testButton);
    await waitFor(() => expect(testButton.getAttribute('disabled')).not.toBeNull());
    expect(mocks.modelApi.test).toHaveBeenCalledWith(model.id);

    resolveTest({ status: 'ok', message: '模型连接正常', latency: 17, response: 'ok' });
    expect(await screen.findByText('连接测试成功')).toBeTruthy();
    expect(screen.getByText(/17 ms/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '编辑 Operations OpenAI' }));
    expect(screen.queryByText(/17 ms/)).toBeNull();
  });

  it('shows connection errors and does not claim success without a key', async () => {
    const noKeyModel = { ...model, id: 'model-no-key', name: 'No Key OpenAI', hasApiKey: false };
    render(<I18nProvider><ModelManagement models={[noKeyModel]} onModelsChange={vi.fn()} tx={(zh) => zh} /></I18nProvider>);

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('未配置 API Key，未发起连接测试。')).toBeTruthy();
    expect(mocks.modelApi.test).not.toHaveBeenCalled();
  });

  it('keeps the model dialog open with the save error and refreshes defaults after saving', async () => {
    const secondaryModel = { ...model, id: 'model-2', name: 'Secondary model', isDefault: false };
    const refreshedModels = [{ ...model, isDefault: false }, { ...secondaryModel, isDefault: true }];
    mocks.modelApi.update.mockResolvedValue({ ...secondaryModel, isDefault: true });
    mocks.modelApi.getAll.mockResolvedValue(refreshedModels);
    const onModelsChange = vi.fn();

    render(<I18nProvider><ModelManagement models={[model, secondaryModel]} onModelsChange={onModelsChange} tx={(zh) => zh} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: '编辑 Secondary model' }));
    fireEvent.click(screen.getByLabelText('设为默认模型'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mocks.modelApi.update).toHaveBeenCalledWith(secondaryModel.id, expect.objectContaining({ isDefault: true })));
    await waitFor(() => expect(onModelsChange).toHaveBeenCalledWith(refreshedModels));

    mocks.modelApi.update.mockRejectedValueOnce(new Error('model save failed'));
    fireEvent.click(screen.getByRole('button', { name: '编辑 Secondary model' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('model save failed')).toBeTruthy();
    });
  });

  it('keeps a null model reference as default instead of binding the draft to its current id', async () => {
    const defaultAgent = { ...agent, config: { temperature: 0.3 } };
    mocks.agentApi.update.mockResolvedValue({ ...defaultAgent, draftRevision: 3 });

    render(<I18nProvider><AgentEditor agent={defaultAgent} models={[model]} open onOpenChange={vi.fn()} onSaved={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText('版本历史')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('第 1 条提示词内容'), { target: { value: 'changed prompt' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(mocks.agentApi.update).toHaveBeenCalledWith(defaultAgent.id, expect.objectContaining({
      config: { temperature: 0.3 },
    })));
  });
});
