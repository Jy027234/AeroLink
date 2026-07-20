import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('FMV route reserved-path handling', () => {
  const calculateFMVMock = vi.fn();
  const prismaMock = {
    quotation: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
  };

  beforeEach(() => {
    vi.resetModules();
    calculateFMVMock.mockReset();
    prismaMock.quotation.findMany.mockReset();
    prismaMock.order.findMany.mockReset();
    vi.doMock('../lib/fmvEngine.js', () => ({ calculateFMV: calculateFMVMock }));
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const router = (await import('./fmv.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/fmv', router);
    app.use(errorHandler);
    return app;
  }

  it('routes POST /batch to the batch handler instead of the part-number handler', async () => {
    calculateFMVMock.mockResolvedValue({
      partNumber: 'PN-1',
      conditionCode: 'SV',
      fmvs: [],
      selectedFMV: 0,
      selectedStage: 0,
      selectedConfidence: 0,
      currency: 'USD',
      calculatedAt: '2026-07-19T00:00:00.000Z',
    });

    const response = await request(await buildApp())
      .post('/api/fmv/batch')
      .send({ items: [{ partNumber: 'PN-1' }] });

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.results[0]).toMatchObject({ partNumber: 'PN-1', success: true });
    expect(calculateFMVMock).toHaveBeenCalledWith('PN-1', 'SV');
  });

  it('routes /history before the generic part-number handler', async () => {
    prismaMock.quotation.findMany.mockResolvedValue([]);
    prismaMock.order.findMany.mockResolvedValue([]);

    const response = await request(await buildApp()).get('/api/fmv/PN-1/history?months=6');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { partNumber: 'PN-1', history: [], count: 0 } });
    expect(calculateFMVMock).not.toHaveBeenCalled();
  });
});
