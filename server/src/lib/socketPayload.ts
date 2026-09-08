/**
 * Socket messages are change notifications.  They deliberately carry only
 * identifiers and small state hints so a connected client must refetch the
 * authorised resource over HTTP.  Keeping this allow-list at the boundary
 * also prevents a future event producer from accidentally forwarding a
 * customer record, email address, or commercial field.
 */

const SOCKET_EVENT_HINT_KEYS = new Set([
  'status',
  'oldStatus',
  'newStatus',
  'state',
  'oldState',
  'newState',
  'nextStatus',
  'changeType',
  'action',
  'reasonCode',
  'version',
  'currentVersion',
  'changedAt',
  'createdAt',
  'updatedAt',
  'submittedAt',
  'reviewedAt',
  'acceptedAt',
  'sentAt',
  'withdrawnAt',
  'reservationReleased',
  'autoCreatedOrder',
  'isDeleted',
  'deleted',
]);

const SOCKET_IDENTIFIER_KEYS = new Set([
  'id',
  'aggregateId',
  'aggregateType',
  'rfqId',
  'rfqNumber',
  'quotationId',
  'quoteNumber',
  'orderId',
  'orderNumber',
  'soNumber',
  'inventoryDetailId',
  'inventoryItemId',
  'inventoryTransactionId',
  'transactionId',
  'contractDocumentId',
  'outboundEmailId',
  'notificationId',
  'agentTaskId',
  'workflowId',
  'customerId',
  'supplierId',
  'inquiryId',
  'documentId',
  'certificateId',
  'partNumber',
  'serialNumber',
  'batchNumber',
  'certificateNumber',
  'referenceNo',
  'referenceType',
  'createdBy',
  'createdById',
  'changedBy',
  'changedById',
  'submittedBy',
  'submittedById',
  'reviewedBy',
  'reviewedById',
  'approvedBy',
  'approvedById',
  'requestedBy',
  'requestedById',
  'userId',
  'userIds',
]);

const MAX_SOCKET_PAYLOAD_DEPTH = 4;
const MAX_SOCKET_ARRAY_ITEMS = 100;
const MAX_SOCKET_OBJECT_KEYS = 100;

function isAllowedSocketKey(key: string) {
  return SOCKET_EVENT_HINT_KEYS.has(key) || SOCKET_IDENTIFIER_KEYS.has(key);
}

function isSimpleScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function sanitizeIdentifierArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const identifiers = value
    .slice(0, MAX_SOCKET_ARRAY_ITEMS)
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
  return identifiers;
}

function isIdentifierArrayKey(key: string) {
  return key === 'userIds';
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SOCKET_PAYLOAD_DEPTH || !value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_SOCKET_OBJECT_KEYS)) {
    if (!isAllowedSocketKey(key)) continue;
    if (isSimpleScalar(item)) {
      sanitized[key] = item;
      continue;
    }
    // The only supported collection is a server-selected list of user IDs;
    // nested objects and arbitrary arrays are never forwarded.
    if (isIdentifierArrayKey(key)) {
      const identifiers = sanitizeIdentifierArray(item);
      if (identifiers) sanitized[key] = identifiers;
    }
  }
  return sanitized;
}

/**
 * Return a sanitised Socket.IO object. Unknown keys and nested objects are
 * dropped, and over-deep values are never returned raw.
 */
export function sanitizeSocketData(value: unknown, depth = 0): unknown {
  return sanitizeValue(value, depth);
}
