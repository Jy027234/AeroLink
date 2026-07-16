export const ORDER_STATUSES = [
  'SO_CREATED',
  'PO_CREATED',
  'SHIPPED',
  'IN_TRANSIT',
  'CUSTOMS',
  'INSPECTION',
  'DELIVERED',
  'COMPLETED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  SO_CREATED: ['PO_CREATED', 'SHIPPED'],
  PO_CREATED: ['SHIPPED'],
  SHIPPED: ['IN_TRANSIT', 'CUSTOMS', 'INSPECTION', 'DELIVERED'],
  IN_TRANSIT: ['CUSTOMS', 'INSPECTION', 'DELIVERED'],
  CUSTOMS: ['IN_TRANSIT', 'INSPECTION', 'DELIVERED'],
  INSPECTION: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
};

export function normalizeOrderStatus(status: string): string {
  return status.trim().toUpperCase().replace(/[-\s]+/g, '_');
}

export function isOrderStatusTransitionAllowed(currentStatus: string, nextStatus: string): boolean {
  const current = normalizeOrderStatus(currentStatus);
  const next = normalizeOrderStatus(nextStatus);

  if (current === next) return true;

  return (ORDER_ALLOWED_TRANSITIONS[current as OrderStatus] || []).includes(next as OrderStatus);
}

export function toUiOrderStatus(status: string): string {
  return normalizeOrderStatus(status).toLowerCase();
}
