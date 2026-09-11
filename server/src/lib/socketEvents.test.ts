import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('scoped Socket.IO events', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  });

  it('creates only a server-managed user room and filters recipients by current capability scope', async () => {
    const prismaMock = {
      user: { findMany: vi.fn(), findUnique: vi.fn() },
      userSession: { findUnique: vi.fn() },
      rFQ: { findUnique: vi.fn() },
      quotation: { findUnique: vi.fn() },
      order: { findUnique: vi.fn() },
    };
    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
    const {
      initSocketIO,
      registerSocketSession,
      unregisterSocketSession,
      emitToAuthorizedUsers,
      userSocketRoom,
    } = await import('./socketEvents.js');

    const roomEmit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit: roomEmit })),
      emit: vi.fn(),
    };
    initSocketIO(io as never);

    const socket = {
      id: 'socket-1',
      data: {} as Record<string, unknown>,
      join: vi.fn(),
      disconnect: vi.fn(),
    };
    const identity = {
      id: 'user-1',
      email: 'sales@example.com',
      name: 'Sales User',
      role: 'sales',
      department: 'Sales',
      avatar: null,
      tokenVersion: 1,
      sessionId: 'session-1',
      accessTokenExpiresAt: Date.now() + 60_000,
    };
    registerSocketSession(socket as never, identity);
    expect(socket.join).toHaveBeenCalledWith(userSocketRoom('user-1'));
    expect(socket.join).toHaveBeenCalledTimes(1);

    prismaMock.user.findMany.mockResolvedValue([
      { id: 'user-1', role: 'sales', department: 'Sales', isActive: true },
      { id: 'manager-sales', role: 'manager', department: 'Sales', isActive: true },
      { id: 'manager-ops', role: 'manager', department: 'Operations', isActive: true },
      { id: 'viewer-sales', role: 'viewer', department: 'Sales', isActive: true },
      { id: 'disabled', role: 'admin', department: 'Sales', isActive: false },
    ]);
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'sales@example.com',
      name: 'Sales User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: true,
      tokenVersion: 1,
    });
    prismaMock.userSession.findUnique.mockResolvedValue({
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(emitToAuthorizedUsers({
      event: 'rfq:updated',
      data: {
        rfqId: 'rfq-1',
        status: 'SUBMITTED',
        unitPrice: 100,
        costNumber: 'do-not-forward',
        customerName: 'Sensitive Customer',
        nested: { costPrice: 20, margin: 80, visible: true },
      },
      scope: { capability: 'rfq.read', ownerId: 'user-1', department: 'Sales' },
    })).resolves.toBe(true);

    expect(io.to).toHaveBeenCalledWith(userSocketRoom('user-1'));
    expect(io.to).toHaveBeenCalledWith(userSocketRoom('manager-sales'));
    expect(io.to).not.toHaveBeenCalledWith(userSocketRoom('manager-ops'));
    expect(io.to).not.toHaveBeenCalledWith(userSocketRoom('viewer-sales'));
    expect(io.to).not.toHaveBeenCalledWith(userSocketRoom('disabled'));
    expect(roomEmit).toHaveBeenCalledWith('rfq:updated', {
      rfqId: 'rfq-1',
      status: 'SUBMITTED',
    });

    unregisterSocketSession(socket as never);
  });

  it('reloads quotation ownership from the current aggregate instead of the approving actor', async () => {
    const prismaMock = {
      user: { findMany: vi.fn(), findUnique: vi.fn() },
      userSession: { findUnique: vi.fn() },
      rFQ: { findUnique: vi.fn() },
      quotation: { findUnique: vi.fn() },
      order: { findUnique: vi.fn() },
    };
    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
    const { initSocketIO, emitToAuthorizedUsers, userSocketRoom } = await import('./socketEvents.js');

    const roomEmit = vi.fn();
    const io = { to: vi.fn(() => ({ emit: roomEmit })), emit: vi.fn() };
    initSocketIO(io as never);
    prismaMock.quotation.findUnique.mockResolvedValue({
      createdBy: 'quotation-owner',
      creator: { department: 'Sales' },
    });
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'quotation-owner', role: 'sales', department: 'Sales', isActive: true },
      { id: 'approver', role: 'manager', department: 'Operations', isActive: true },
      { id: 'sales-manager', role: 'manager', department: 'Sales', isActive: true },
    ]);

    await expect(emitToAuthorizedUsers({
      event: 'quotation:approved',
      aggregateType: 'QUOTATION',
      aggregateId: 'quotation-1',
      data: { quotationId: 'quotation-1', status: 'APPROVED', approvedBy: 'approver' },
      // This is intentionally the action actor and must be ignored for a
      // quotation aggregate.
      scope: { capability: 'quotation.read', ownerId: 'approver', department: 'Operations' },
    })).resolves.toBe(true);

    expect(io.to).toHaveBeenCalledWith(userSocketRoom('quotation-owner'));
    expect(io.to).toHaveBeenCalledWith(userSocketRoom('sales-manager'));
    expect(io.to).not.toHaveBeenCalledWith(userSocketRoom('approver'));
  });

  it('disconnects an established socket when current user state becomes invalid', async () => {
    vi.useFakeTimers();
    const prismaMock = {
      user: { findMany: vi.fn(), findUnique: vi.fn() },
      userSession: { findUnique: vi.fn() },
    };
    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
    const {
      initSocketIO,
      registerSocketSession,
      startSocketSessionRevalidation,
      stopSocketSessionRevalidation,
    } = await import('./socketEvents.js');
    initSocketIO({ to: vi.fn(), emit: vi.fn() } as never);
    const socket = {
      id: 'socket-revoked',
      data: {} as Record<string, unknown>,
      join: vi.fn(),
      disconnect: vi.fn(),
    };
    registerSocketSession(socket as never, {
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      role: 'sales',
      department: 'Sales',
      avatar: null,
      tokenVersion: 1,
      sessionId: 'session-1',
      accessTokenExpiresAt: Date.now() + 60_000,
    });
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: false,
      tokenVersion: 1,
    });

    startSocketSessionRevalidation(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    stopSocketSessionRevalidation();
    vi.useRealTimers();
  });
});
