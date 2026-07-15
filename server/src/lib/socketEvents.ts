import { Server } from 'socket.io';
import { logger } from './logger.js';

let ioInstance: Server | null = null;

export function initSocketIO(io: Server) {
  ioInstance = io;
}

export function getIO(): Server {
  if (!ioInstance) {
    throw new Error('Socket.IO not initialized');
  }
  return ioInstance;
}

export function emitToRoom(room: string, event: string, data: unknown) {
  try {
    const io = getIO();
    io.to(room).emit(event, data);
    logger.debug({ room, event }, 'Socket event emitted to room');
    return true;
  } catch (error) {
    logger.error({ error, room, event }, 'Failed to emit socket event');
    return false;
  }
}

export function emitToAll(event: string, data: unknown) {
  try {
    const io = getIO();
    io.emit(event, data);
    logger.debug({ event }, 'Socket event emitted to all');
    return true;
  } catch (error) {
    logger.error({ error, event }, 'Failed to emit socket event to all');
    return false;
  }
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

export const SocketRooms = {
  DASHBOARD: 'dashboard',
  RFQS: 'rfqs',
  QUOTATIONS: 'quotations',
  ORDERS: 'orders',
  INVENTORY: 'inventory',
  EMAILS: 'emails',
  NOTIFICATIONS: 'notifications',
} as const;
