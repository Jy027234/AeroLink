import type { Server, Socket } from 'socket.io';
import type {
  CapabilityAction,
  CapabilityResource,
  CapabilityResourceContext,
} from './capabilityPolicy.js';
import { hasCapability } from './capabilityPolicy.js';
import prisma from './prisma.js';
import {
  revalidateCurrentAuthIdentity,
  type CurrentAuthIdentity,
} from '../middleware/auth.js';
import { logger } from './logger.js';
import { sanitizeSocketData } from './socketPayload.js';

let ioInstance: Server | null = null;
const socketSessions = new Map<string, { socket: Socket; identity: CurrentAuthIdentity }>();
let socketRevalidationTimer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_SOCKET_AUTH_RECHECK_INTERVAL_MS = 60_000;
const MIN_SOCKET_AUTH_RECHECK_INTERVAL_MS = 10_000;
const MAX_SOCKET_AUTH_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

function readSocketRevalidationInterval() {
  const configured = Number.parseInt(process.env.SOCKET_AUTH_RECHECK_INTERVAL_MS ?? '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_SOCKET_AUTH_RECHECK_INTERVAL_MS;
  return Math.min(
    MAX_SOCKET_AUTH_RECHECK_INTERVAL_MS,
    Math.max(MIN_SOCKET_AUTH_RECHECK_INTERVAL_MS, configured),
  );
}

export function initSocketIO(io: Server) {
  ioInstance = io;
}

export function getIO(): Server {
  if (!ioInstance) {
    throw new Error('Socket.IO not initialized');
  }
  return ioInstance;
}

export const SOCKET_USER_ROOM_PREFIX = 'user:';

export function userSocketRoom(userId: string) {
  return `${SOCKET_USER_ROOM_PREFIX}${userId}`;
}

/**
 * Register only the server-computed user room.  Clients never choose a user
 * room, so a valid token cannot subscribe to another employee's stream.
 */
export function registerSocketSession(socket: Socket, identity: CurrentAuthIdentity) {
  socketSessions.set(socket.id, { socket, identity });
  socket.data.authIdentity = identity;
  socket.data.user = {
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role: identity.role,
    department: identity.department,
    avatar: identity.avatar,
  };
  socket.join(userSocketRoom(identity.id));
}

export function unregisterSocketSession(socket: Socket) {
  socketSessions.delete(socket.id);
}

async function revalidateSocketSessions() {
  for (const [socketId, session] of socketSessions) {
    try {
      const identity = await revalidateCurrentAuthIdentity(session.identity);
      session.identity = identity;
      session.socket.data.authIdentity = identity;
      session.socket.data.user = {
        id: identity.id,
        email: identity.email,
        name: identity.name,
        role: identity.role,
        department: identity.department,
        avatar: identity.avatar,
      };
    } catch (error) {
      // Revocation, disabling, token-version changes and access-token expiry
      // all close the live connection.  The next connection must authenticate
      // again and receive a fresh capability scope.
      logger.info({ socketId, userId: session.identity.id, error }, 'Socket identity is no longer valid; disconnecting');
      try {
        session.socket.disconnect(true);
      } finally {
        socketSessions.delete(socketId);
      }
    }
  }
}

export function startSocketSessionRevalidation(intervalMs = readSocketRevalidationInterval()) {
  stopSocketSessionRevalidation();
  socketRevalidationTimer = setInterval(() => {
    void revalidateSocketSessions().catch((error) => {
      logger.warn({ error }, 'Socket identity revalidation cycle failed');
    });
  }, intervalMs);
  // The timer is maintenance work and must not keep a graceful shutdown alive.
  if (typeof socketRevalidationTimer.unref === 'function') socketRevalidationTimer.unref();
}

export function stopSocketSessionRevalidation() {
  if (!socketRevalidationTimer) return;
  clearInterval(socketRevalidationTimer);
  socketRevalidationTimer = null;
}

// Re-export the single boundary sanitizer for existing internal callers and
// tests.  Both enqueue and final emit use the same strict allow-list.
export { sanitizeSocketData };

export type SocketEventScope = {
  capability?: string;
  ownerId?: string | null;
  department?: string | null;
  /** Server-supplied recipients are still checked against current capability. */
  userIds?: string[];
};

export type AuthorizedSocketEvent = {
  event: string;
  data: Record<string, unknown>;
  scope?: SocketEventScope;
  /** Outbox metadata used to resolve the current aggregate owner. */
  aggregateType?: string;
  aggregateId?: string;
};

const eventCapabilityMap: Record<string, [CapabilityResource, CapabilityAction]> = {
  dashboard: ['dashboard', 'read'],
  rfq: ['rfq', 'read'],
  quotation: ['quotation', 'read'],
  order: ['order', 'read'],
  inventory: ['inventory', 'read'],
  email: ['email', 'read'],
  agent: ['agent', 'read'],
  // Notifications are user-scoped by default; session.read is an own grant
  // for ordinary roles, so an omitted recipient list cannot become a broadcast.
  notification: ['session', 'read'],
  session: ['session', 'read'],
};

function parseCapability(value: string | undefined, event: string): [CapabilityResource, CapabilityAction] | null {
  const candidate = value?.trim().toLowerCase() || event.trim().toLowerCase().split(/[.:]/)[0];
  const [resource, action = 'read'] = candidate.split('.', 2);
  if (!resource || !action) return null;

  const mapped = eventCapabilityMap[resource];
  if (mapped && action === 'read') return mapped;

  const knownResources = new Set(Object.keys(eventCapabilityMap));
  const knownActions = new Set<CapabilityAction>([
    'read', 'create', 'update', 'delete', 'transition', 'approve', 'send', 'accept',
    'withdraw', 'manage', 'reconcile', 'export', 'issue', 'view_cost', 'run',
  ]);
  if (!knownResources.has(resource) || !knownActions.has(action as CapabilityAction)) return null;
  return [resource as CapabilityResource, action as CapabilityAction];
}

type SocketRecipient = {
  id: string;
  role: string;
  department: string | null;
  isActive?: boolean;
};

type AuthoritativeAggregateScope = {
  ownerId: string | null;
  department: string | null;
};

function normalizeAggregateType(value: string | undefined) {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (normalized === 'RFQ' || normalized === 'QUOTATION' || normalized === 'ORDER') return normalized;
  return null;
}

function readAggregateId(input: AuthorizedSocketEvent, aggregateType: string) {
  if (input.aggregateId?.trim()) return input.aggregateId.trim();
  const key = aggregateType === 'RFQ'
    ? 'rfqId'
    : aggregateType === 'QUOTATION'
      ? 'quotationId'
      : 'orderId';
  const value = input.data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the live business-document owner and department.  The actor that
 * created an outbox row can approve or transition somebody else's document,
 * so createdById and payload owner hints are never authoritative here.
 */
async function resolveAuthoritativeAggregateScope(input: AuthorizedSocketEvent): Promise<AuthoritativeAggregateScope> {
  const aggregateType = normalizeAggregateType(input.aggregateType);
  if (!aggregateType) {
    return {
      ownerId: input.scope?.ownerId ?? null,
      department: input.scope?.department ?? null,
    };
  }

  const aggregateId = readAggregateId(input, aggregateType);
  if (!aggregateId) return { ownerId: null, department: null };

  try {
    if (aggregateType === 'RFQ') {
      const row = await prisma.rFQ.findUnique({
        where: { id: aggregateId },
        select: { createdBy: true, creator: { select: { department: true } } },
      });
      return row
        ? { ownerId: row.createdBy, department: row.creator?.department ?? null }
        : { ownerId: null, department: null };
    }

    if (aggregateType === 'QUOTATION') {
      const row = await prisma.quotation.findUnique({
        where: { id: aggregateId },
        select: { createdBy: true, creator: { select: { department: true } } },
      });
      return row
        ? { ownerId: row.createdBy, department: row.creator?.department ?? null }
        : { ownerId: null, department: null };
    }

    const row = await prisma.order.findUnique({
      where: { id: aggregateId },
      select: {
        quotation: {
          select: { createdBy: true, creator: { select: { department: true } } },
        },
      },
    });
    return row?.quotation
      ? { ownerId: row.quotation.createdBy, department: row.quotation.creator?.department ?? null }
      : { ownerId: null, department: null };
  } catch (error) {
    // A malformed/legacy row must not fall back to the action actor.  Dropping
    // owner scope may still allow a current admin capability, while ordinary
    // own/department grants remain unable to receive the event.
    logger.warn({ error, aggregateType, aggregateId }, 'Unable to resolve current socket aggregate owner');
    return { ownerId: null, department: null };
  }
}

/**
 * Re-evaluate recipients against current active users and the capability
 * policy for every event.  This keeps a stale connection from receiving a
 * newly out-of-scope update and supports own/department policy scopes.
 */
export async function emitToAuthorizedUsers(input: AuthorizedSocketEvent): Promise<boolean> {
  try {
    const io = getIO();
    const capability = parseCapability(input.scope?.capability, input.event);
    if (!capability) {
      logger.warn({ event: input.event }, 'Socket event has no recognized capability; dropping it');
      return true;
    }

    const authoritativeScope = await resolveAuthoritativeAggregateScope(input);
    const userIds = input.scope?.userIds?.filter(Boolean);
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        ...(userIds?.length ? { id: { in: userIds } } : {}),
      },
      select: { id: true, role: true, department: true, isActive: true },
    }) as SocketRecipient[];
    const context: CapabilityResourceContext = {
      ownerId: authoritativeScope.ownerId,
      department: authoritativeScope.department,
    };
    const data = (sanitizeSocketData(input.data) ?? {}) as Record<string, unknown>;

    for (const user of users) {
      if (user.isActive === false) continue;
      if (!hasCapability({ id: user.id, role: user.role, department: user.department }, capability[0], capability[1], context)) {
        continue;
      }
      // Revalidate every established connection immediately before its room
      // emission.  The periodic sweep is only a backstop; a revoked session
      // must not receive the next event while it waits for that timer.
      await revalidateSocketSessions();
      io.to(userSocketRoom(user.id)).emit(input.event, data);
    }
    logger.debug({ event: input.event, recipientCount: users.length }, 'Socket event emitted to authorized user rooms');
    return true;
  } catch (error) {
    logger.error({ error, event: input.event }, 'Failed to emit authorized socket event');
    return false;
  }
}

/** Compatibility alias for callers that describe this as a scoped emission. */
export const emitScopedSocketEvent = emitToAuthorizedUsers;

/**
 * Legacy room emission is intentionally disabled.  Every production event
 * must go through emitToAuthorizedUsers, which reloads recipients and checks
 * capability scope.  Retaining this stub avoids turning an old caller into a
 * silent data broadcast during a rolling upgrade.
 */
export function emitToRoom(room: string, event: string, data: unknown) {
  logger.warn({ room, event }, 'Legacy unrestricted socket room emission is disabled');
  void data;
  return false;
}

export const SocketEvents = {
  RFQ_CREATED: 'rfq:created',
  RFQ_UPDATED: 'rfq:updated',
  QUOTATION_CREATED: 'quotation:created',
  QUOTATION_SUBMITTED: 'quotation:submitted',
  QUOTATION_APPROVED: 'quotation:approved',
  QUOTATION_SENT: 'quotation:sent',
  QUOTATION_UPDATED: 'quotation:updated',
  ORDER_CREATED: 'order:created',
  ORDER_STATUS_CHANGED: 'order:status_changed',
  INVENTORY_UPDATED: 'inventory:updated',
  EMAIL_RECEIVED: 'email:received',
  NOTIFICATION: 'notification',
  AGENT_TASK_COMPLETED: 'agent:task_completed',
} as const;

// These labels remain part of the enqueue API for compatibility.  They are
// metadata only; clients cannot join them and dispatch never trusts them as a
// recipient selector.
export const SocketRooms = {
  DASHBOARD: 'dashboard',
  RFQS: 'rfqs',
  QUOTATIONS: 'quotations',
  ORDERS: 'orders',
  INVENTORY: 'inventory',
  EMAILS: 'emails',
  NOTIFICATIONS: 'notifications',
} as const;
