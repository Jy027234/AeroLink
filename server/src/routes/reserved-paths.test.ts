import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('reserved collection route precedence', () => {
  const prismaMock = {
    auction: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    auctionBid: {
      findMany: vi.fn(),
    },
    consignment: {
      findMany: vi.fn(),
      fields: { minStockLevel: 'minStockLevel' },
    },
  };

  beforeEach(() => {
    vi.resetModules();
    Object.values(prismaMock.auction).forEach((mock) => {
      if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset();
    });
    prismaMock.auctionBid.findMany.mockReset();
    prismaMock.consignment.findMany.mockReset();
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const auctions = (await import('./auctions.js')).default;
    const consignments = (await import('./consignments.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin', name: 'Admin' } });
      next();
    });
    app.use('/api/auctions', auctions);
    app.use('/api/consignments', consignments);
    app.use(errorHandler);
    return app;
  }

  it('dispatches /auctions/active to the active collection handler', async () => {
    prismaMock.auction.findMany.mockResolvedValue([]);
    prismaMock.auction.count.mockResolvedValue(0);

    const response = await request(await buildApp()).get('/api/auctions/active');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: [], pagination: { total: 0 } });
    expect(prismaMock.auction.findMany).toHaveBeenCalled();
  });

  it('dispatches /auctions/my-bids to the current-user collection handler', async () => {
    prismaMock.auctionBid.findMany.mockResolvedValue([]);

    const response = await request(await buildApp()).get('/api/auctions/my-bids');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: [], pagination: { total: 0 } });
    expect(prismaMock.auctionBid.findMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['auctionId'] }));
  });

  it('dispatches /consignments/alerts before the /:id detail route', async () => {
    prismaMock.consignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const response = await request(await buildApp()).get('/api/consignments/alerts');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { expiring: [], lowStock: [], totalAlerts: 0 } });
    expect(prismaMock.consignment.findMany).toHaveBeenCalledTimes(2);
  });
});
