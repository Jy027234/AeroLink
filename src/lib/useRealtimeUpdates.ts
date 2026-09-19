import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { authApi, getAccessToken } from '@/api/client';
import { queryKeys } from '@/lib/queryClient';
import { useCapabilityStore } from '@/store/capabilityStore';

type RealtimeUpdateOptions = {
  enabled: boolean;
  onAuthenticationFailure?: () => void;
};

const REALTIME_EVENTS = [
  'rfq:created',
  'rfq:updated',
  'quotation:created',
  'quotation:submitted',
  'quotation:approved',
  'quotation:sent',
  'quotation:updated',
  'order:created',
  'order:status_changed',
  'inventory:updated',
  'email:received',
  'notification',
  'agent:task_completed',
  'session:updated',
] as const;

function socketEndpoint() {
  const configuredApiUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (!configuredApiUrl || typeof window === 'undefined') return undefined;
  try {
    return new URL(configuredApiUrl, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

function isAuthenticationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /auth|credential|session|token|unauthor|invalid current/i.test(message);
}

/**
 * Subscribe to server-managed user-room change hints.  Payloads intentionally
 * contain no business record; invalidation refetches the current authorised
 * HTTP representation instead.
 */
export function useRealtimeUpdates({ enabled, onAuthenticationFailure }: RealtimeUpdateOptions) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !getAccessToken()) return undefined;

    const socket: Socket = io(socketEndpoint(), {
      autoConnect: false,
      auth: { token: getAccessToken() },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    });

    let invalidationTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshAttempted = false;
    let refreshInFlight: Promise<void> | null = null;
    let disposed = false;

    const invalidateAuthorisedQueries = () => {
      if (invalidationTimer) return;
      invalidationTimer = setTimeout(() => {
        invalidationTimer = null;
        void queryClient.invalidateQueries({
          queryKey: queryKeys.all,
          refetchType: 'active',
        });
      }, 50);
    };

    const refreshAndReconnect = () => {
      if (refreshAttempted || refreshInFlight) return refreshInFlight;
      refreshAttempted = true;
      socket.disconnect();
      refreshInFlight = authApi.refresh()
        .then(() => {
          if (disposed) return;
          const token = getAccessToken();
          if (!token) throw new Error('Refresh did not return an access token');
          socket.auth = { token };
          socket.connect();
        })
        .catch(() => {
          if (disposed) return;
          socket.disconnect();
          onAuthenticationFailure?.();
        })
        .finally(() => {
          refreshInFlight = null;
        });
      return refreshInFlight;
    };

    const handleConnected = () => {
      refreshAttempted = false;
      // A reconnect may follow an access-token rotation.  The next HTTP
      // request must use the current capability and current resource scope.
      invalidateAuthorisedQueries();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.all,
        refetchType: 'active',
      });
      void useCapabilityStore.getState().load();
    };
    const handleChangeHint = () => {
      invalidateAuthorisedQueries();
    };
    const handleConnectError = (error: Error) => {
      if (isAuthenticationError(error)) void refreshAndReconnect();
    };
    const handleDisconnect = (reason: string) => {
      // Socket.IO does not automatically reconnect after an explicit server
      // disconnect, which is how revoked/expired sessions are closed.
      if (reason === 'io server disconnect') void refreshAndReconnect();
    };

    socket.on('connect', handleConnected);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);
    for (const event of REALTIME_EVENTS) socket.on(event, handleChangeHint);
    socket.connect();

    return () => {
      disposed = true;
      if (invalidationTimer) clearTimeout(invalidationTimer);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [enabled, onAuthenticationFailure, queryClient]);
}
