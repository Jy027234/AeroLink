import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtimeUpdates } from './useRealtimeUpdates';

const getAccessTokenMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const capabilityLoadMock = vi.hoisted(() => vi.fn());
const ioMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  authApi: { refresh: refreshMock },
  getAccessToken: getAccessTokenMock,
}));

vi.mock('@/store/capabilityStore', () => ({
  useCapabilityStore: {
    getState: () => ({ load: capabilityLoadMock }),
  },
}));

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

type FakeSocket = {
  auth: Record<string, unknown>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
};

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    auth: {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    removeAllListeners: vi.fn(() => {
      handlers.clear();
    }),
    emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args);
    },
  };
  return socket;
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useRealtimeUpdates', () => {
  let socket: FakeSocket;
  let queryClient: QueryClient;

  beforeEach(() => {
    socket = createFakeSocket();
    queryClient = new QueryClient();
    getAccessTokenMock.mockReturnValue('access-1');
    refreshMock.mockResolvedValue(undefined);
    capabilityLoadMock.mockResolvedValue(undefined);
    ioMock.mockReturnValue(socket);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it('refreshes once after an authentication disconnect and invalidates queries after reconnect', async () => {
    let currentToken = 'access-1';
    getAccessTokenMock.mockImplementation(() => currentToken);
    refreshMock.mockImplementation(async () => {
      currentToken = 'access-2';
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(
      () => useRealtimeUpdates({ enabled: true }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      socket.emit('connect_error', new Error('Invalid current session'));
      socket.emit('connect_error', new Error('Invalid current session'));
      await refreshMock.mock.results[0]?.value;
    });

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'access-2' });
    expect(socket.connect).toHaveBeenCalledTimes(2);

    await act(async () => {
      socket.emit('connect');
    });
    expect(invalidateQueries).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['aerolink'],
      refetchType: 'active',
    }));

    unmount();
  });
});
