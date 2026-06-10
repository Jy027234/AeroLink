import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const buildRuntimeTaskRecord = () => ({
  id: 'task_runtime_001',
  triggerType: 'email',
  triggerSource: 'demo@airlines.com',
  triggerReferenceId: 'demo_email_001',
  type: 'email_received',
  status: 'waiting_confirmation',
  currentStepIndex: 1,
  context: JSON.stringify({
    parsedData: {
      partNumber: 'BAC31GK0020',
      customerName: '海南航空',
      quantity: 2,
      urgency: 'aog',
    },
  }),
  result: null,
  error: null,
  createdAt: new Date('2026-05-12T09:00:00.000Z'),
  updatedAt: new Date('2026-05-12T09:01:00.000Z'),
  completedAt: null,
  steps: [
    {
      id: 'step_1',
      taskId: 'task_runtime_001',
      sequence: 0,
      capability: 'email',
      action: 'parse',
      params: JSON.stringify({}),
      status: 'completed',
      result: JSON.stringify({ parsedData: { partNumber: 'BAC31GK0020' } }),
      error: null,
      startedAt: new Date('2026-05-12T09:00:05.000Z'),
      completedAt: new Date('2026-05-12T09:00:10.000Z'),
      createdAt: new Date('2026-05-12T09:00:00.000Z'),
      updatedAt: new Date('2026-05-12T09:00:10.000Z'),
    },
  ],
  confirmation: {
    id: 'confirm_runtime_001',
    taskId: 'task_runtime_001',
    stepId: 'step_2',
    type: 'rfq_confirm',
    title: '需求单生成确认',
    titleZh: '需求单生成确认',
    titleEn: 'RFQ Creation Confirmation',
    description: '请确认AI解析的需求信息是否正确',
    descriptionZh: '请确认AI解析的需求信息是否正确',
    descriptionEn: 'Please confirm the AI-parsed RFQ details before creating the RFQ.',
    data: JSON.stringify({ parsedData: { customerName: '海南航空' } }),
    options: JSON.stringify([
      { id: 'confirm', label: '确认生成', labelZh: '确认生成', labelEn: 'Create RFQ', action: 'proceed' },
      { id: 'cancel', label: '取消', labelZh: '取消', labelEn: 'Cancel', action: 'cancel' },
    ]),
    selectedOption: null,
    confirmedAt: null,
    confirmedBy: null,
    createdAt: new Date('2026-05-12T09:00:30.000Z'),
    updatedAt: new Date('2026-05-12T09:00:30.000Z'),
  },
});

const buildLatestConfirmationAudit = (taskId = 'task_runtime_001') => ({
  confirmationId: 'confirm_runtime_001',
  taskId,
  stepId: 'step_2',
  type: 'rfq_confirm',
  optionId: 'confirm',
  action: 'proceed',
  optionLabel: '确认生成',
  optionLabelZh: '确认生成',
  optionLabelEn: 'Create RFQ',
  confirmedAt: '2026-05-12T09:00:45.000Z',
  confirmedBy: '张经理 <zhang@aerolink.com>',
  note: '价格和交期都满足预期，允许继续创建需求单。',
  reasonCode: 'best_value',
  reasonLabel: '综合性价比最佳',
  reasonLabelZh: '综合性价比最佳',
  reasonLabelEn: 'Best overall value',
});

describe('Agent runtime routes integration', () => {
  let app: express.Application;
  let prismaMock: {
    agentRuntimeTask: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    agentRuntimeStep: {
      deleteMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    agentRuntimeConfirmation: {
      upsert: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
    agentLog: {
      create: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const runtimeTaskRecord = buildRuntimeTaskRecord();

    prismaMock = {
      agentRuntimeTask: {
        findMany: vi.fn().mockResolvedValue([runtimeTaskRecord]),
        findUnique: vi.fn().mockResolvedValue(runtimeTaskRecord),
        count: vi.fn().mockResolvedValue(1),
        upsert: vi.fn().mockResolvedValue(runtimeTaskRecord),
      },
      agentRuntimeStep: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentRuntimeConfirmation: {
        upsert: vi.fn().mockResolvedValue(runtimeTaskRecord.confirmation),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentLog: {
        create: vi.fn().mockResolvedValue({ id: 'log_runtime_001' }),
      },
      $transaction: vi.fn(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock)),
    };

    vi.doMock('../lib/prisma.js', () => ({
      default: prismaMock,
    }));

    const router = (await import('./agents.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');

    app = express();
    app.use(express.json());
    app.use('/api/agents', router);
    app.use(errorHandler);
  });

  it('should sync a runtime task with bilingual confirmation metadata', async () => {
    const payload = {
      id: 'task_runtime_001',
      trigger: {
        type: 'email',
        source: 'demo@airlines.com',
        referenceId: 'demo_email_001',
      },
      type: 'email_received',
      status: 'waiting_confirmation',
      currentStepIndex: 1,
      steps: [
        {
          id: 'step_1',
          capability: 'email',
          action: 'parse',
          params: {},
          status: 'completed',
          result: { parsedData: { partNumber: 'BAC31GK0020' } },
          startedAt: '2026-05-12T09:00:05.000Z',
          completedAt: '2026-05-12T09:00:10.000Z',
        },
      ],
      confirmationNode: {
        id: 'confirm_runtime_001',
        taskId: 'task_runtime_001',
        stepId: 'step_2',
        type: 'rfq_confirm',
        title: '需求单生成确认',
        titleZh: '需求单生成确认',
        titleEn: 'RFQ Creation Confirmation',
        description: '请确认AI解析的需求信息是否正确',
        descriptionZh: '请确认AI解析的需求信息是否正确',
        descriptionEn: 'Please confirm the AI-parsed RFQ details before creating the RFQ.',
        data: { parsedData: { customerName: '海南航空' } },
        options: [
          { id: 'confirm', label: '确认生成', labelZh: '确认生成', labelEn: 'Create RFQ', action: 'proceed' },
          { id: 'cancel', label: '取消', labelZh: '取消', labelEn: 'Cancel', action: 'cancel' },
        ],
      },
      context: {
        parsedData: {
          partNumber: 'BAC31GK0020',
          customerName: '海南航空',
          quantity: 2,
          urgency: 'aog',
        },
      },
      createdAt: '2026-05-12T09:00:00.000Z',
      updatedAt: '2026-05-12T09:01:00.000Z',
    };

    const res = await request(app)
      .put('/api/agents/runtime/tasks/task_runtime_001')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.agentRuntimeStep.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            id: 'task_runtime_001::step_1',
          }),
        ],
      })
    );
    expect(prismaMock.agentRuntimeConfirmation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          id: 'task_runtime_001::confirm_runtime_001',
        }),
        create: expect.objectContaining({
          id: 'task_runtime_001::confirm_runtime_001',
        }),
      })
    );
    expect(res.body.data.confirmationNode.titleEn).toBe('RFQ Creation Confirmation');
    expect(res.body.data.confirmationNode.options[0].labelEn).toBe('Create RFQ');
  });

  it('should namespace repeated local step and confirmation ids per task', async () => {
    const payload = {
      id: 'task_runtime_002',
      trigger: {
        type: 'email',
        source: 'demo@airlines.com',
        referenceId: 'demo_email_002',
      },
      type: 'email_received',
      status: 'waiting_confirmation',
      currentStepIndex: 1,
      steps: [
        {
          id: 'step_1',
          capability: 'email',
          action: 'parse',
          params: {},
          status: 'completed',
          result: { parsedData: { partNumber: 'BAC31GK0020' } },
          startedAt: '2026-05-12T09:00:05.000Z',
          completedAt: '2026-05-12T09:00:10.000Z',
        },
      ],
      confirmationNode: {
        id: 'confirm_runtime_001',
        taskId: 'task_runtime_002',
        stepId: 'step_2',
        type: 'rfq_confirm',
        title: '需求单生成确认',
        titleZh: '需求单生成确认',
        titleEn: 'RFQ Creation Confirmation',
        description: '请确认AI解析的需求信息是否正确',
        descriptionZh: '请确认AI解析的需求信息是否正确',
        descriptionEn: 'Please confirm the AI-parsed RFQ details before creating the RFQ.',
        data: { parsedData: { customerName: '海南航空' } },
        options: [
          { id: 'confirm', label: '确认生成', labelZh: '确认生成', labelEn: 'Create RFQ', action: 'proceed' },
          { id: 'cancel', label: '取消', labelZh: '取消', labelEn: 'Cancel', action: 'cancel' },
        ],
      },
      context: {
        parsedData: {
          partNumber: 'BAC31GK0020',
          customerName: '海南航空',
          quantity: 2,
          urgency: 'aog',
        },
      },
      createdAt: '2026-05-12T09:02:00.000Z',
      updatedAt: '2026-05-12T09:03:00.000Z',
    };

    const res = await request(app)
      .put('/api/agents/runtime/tasks/task_runtime_002')
      .send(payload);

    expect(res.status).toBe(200);
    expect(prismaMock.agentRuntimeStep.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            id: 'task_runtime_002::step_1',
            taskId: 'task_runtime_002',
          }),
        ],
      })
    );
    expect(prismaMock.agentRuntimeConfirmation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          id: 'task_runtime_002::confirm_runtime_001',
        }),
        create: expect.objectContaining({
          id: 'task_runtime_002::confirm_runtime_001',
          taskId: 'task_runtime_002',
        }),
      })
    );
  });

  it('should create a structured agent log when a new confirmation audit arrives', async () => {
    const latestConfirmation = buildLatestConfirmationAudit();
    const payload = {
      id: 'task_runtime_001',
      trigger: {
        type: 'email',
        source: 'demo@airlines.com',
        referenceId: 'demo_email_001',
      },
      type: 'rfq_created',
      status: 'completed',
      currentStepIndex: 3,
      steps: [
        {
          id: 'step_1',
          capability: 'email',
          action: 'parse',
          params: {},
          status: 'completed',
          result: { parsedData: { partNumber: 'BAC31GK0020' } },
          startedAt: '2026-05-12T09:00:05.000Z',
          completedAt: '2026-05-12T09:00:10.000Z',
        },
      ],
      context: {
        parsedData: {
          partNumber: 'BAC31GK0020',
          customerName: '海南航空',
          quantity: 2,
          urgency: 'aog',
        },
        latestConfirmation,
        confirmationHistory: [latestConfirmation],
      },
      result: {
        rfqNumber: 'RFQ-20260512-CIZ1',
      },
      createdAt: '2026-05-12T09:00:00.000Z',
      updatedAt: '2026-05-12T09:01:00.000Z',
      completedAt: '2026-05-12T09:01:00.000Z',
    };

    const res = await request(app)
      .put('/api/agents/runtime/tasks/task_runtime_001')
      .send(payload);

    expect(res.status).toBe(200);
    expect(prismaMock.agentLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: 'task_runtime_001',
          action: 'CONFIRMATION_RECORDED',
          status: 'SUCCESS',
        }),
      })
    );

    const logCreateCall = prismaMock.agentLog.create.mock.calls[0]?.[0];
    expect(logCreateCall.data.input).toContain('confirm_runtime_001');
    expect(logCreateCall.data.input).toContain('zhang@aerolink.com');
    expect(logCreateCall.data.input).toContain('价格和交期都满足预期');
    expect(logCreateCall.data.input).toContain('best_value');
    expect(logCreateCall.data.output).toContain('Create RFQ');
    expect(logCreateCall.data.output).toContain('综合性价比最佳');
  });

  it('should not duplicate agent logs for the same confirmation audit', async () => {
    const latestConfirmation = buildLatestConfirmationAudit();
    const runtimeTaskRecord = buildRuntimeTaskRecord();
    runtimeTaskRecord.context = JSON.stringify({
      parsedData: {
        partNumber: 'BAC31GK0020',
        customerName: '海南航空',
        quantity: 2,
        urgency: 'aog',
      },
      latestConfirmation,
      confirmationHistory: [latestConfirmation],
    });
    prismaMock.agentRuntimeTask.findUnique.mockResolvedValue(runtimeTaskRecord);

    const payload = {
      id: 'task_runtime_001',
      trigger: {
        type: 'email',
        source: 'demo@airlines.com',
        referenceId: 'demo_email_001',
      },
      type: 'rfq_created',
      status: 'completed',
      currentStepIndex: 3,
      steps: [
        {
          id: 'step_1',
          capability: 'email',
          action: 'parse',
          params: {},
          status: 'completed',
          result: { parsedData: { partNumber: 'BAC31GK0020' } },
          startedAt: '2026-05-12T09:00:05.000Z',
          completedAt: '2026-05-12T09:00:10.000Z',
        },
      ],
      context: {
        parsedData: {
          partNumber: 'BAC31GK0020',
          customerName: '海南航空',
          quantity: 2,
          urgency: 'aog',
        },
        latestConfirmation,
        confirmationHistory: [latestConfirmation],
      },
      result: {
        rfqNumber: 'RFQ-20260512-CIZ1',
      },
      createdAt: '2026-05-12T09:00:00.000Z',
      updatedAt: '2026-05-12T09:01:00.000Z',
      completedAt: '2026-05-12T09:01:00.000Z',
    };

    const res = await request(app)
      .put('/api/agents/runtime/tasks/task_runtime_001')
      .send(payload);

    expect(res.status).toBe(200);
    expect(prismaMock.agentLog.create).not.toHaveBeenCalled();
  });

  it('should list runtime tasks', async () => {
    const res = await request(app).get('/api/agents/runtime/tasks?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('task_runtime_001');
  });
});
