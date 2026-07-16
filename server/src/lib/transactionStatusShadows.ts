import {
  type OrderStatusEnum,
  type QuotationStatusEnum,
  type RfqStatusEnum,
  type SupplierQuoteStatusEnum,
} from '@prisma/client';
import { normalizeOrderStatus } from './orderStateMachine.js';
import { normalizeQuotationStatus } from './quotationStateMachine.js';
import { normalizeRfqStatus } from './rfqStateMachine.js';

export const SUPPLIER_QUOTE_STATUSES = ['pending', 'accepted', 'rejected', 'expired'] as const;
type SupplierQuoteStatus = (typeof SUPPLIER_QUOTE_STATUSES)[number];

function normalizeSupplierQuoteStatus(value: unknown): SupplierQuoteStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SUPPLIER_QUOTE_STATUSES.includes(normalized as SupplierQuoteStatus)
    ? normalized as SupplierQuoteStatus
    : null;
}

export function toRfqStatusEnum(value: unknown): RfqStatusEnum | null {
  return normalizeRfqStatus(value) as RfqStatusEnum | null;
}

export function toQuotationStatusEnum(value: unknown): QuotationStatusEnum | null {
  return normalizeQuotationStatus(value) as QuotationStatusEnum | null;
}

export function toOrderStatusEnum(value: unknown): OrderStatusEnum | null {
  const normalized = typeof value === 'string' ? normalizeOrderStatus(value) : null;
  return normalized && [
    'SO_CREATED',
    'PO_CREATED',
    'SHIPPED',
    'IN_TRANSIT',
    'CUSTOMS',
    'INSPECTION',
    'DELIVERED',
    'COMPLETED',
  ].includes(normalized)
    ? normalized as OrderStatusEnum
    : null;
}

export function toSupplierQuoteStatusEnum(value: unknown): SupplierQuoteStatusEnum | null {
  return normalizeSupplierQuoteStatus(value) as SupplierQuoteStatusEnum | null;
}

export function preferredRfqStatus(
  statusEnum: RfqStatusEnum | null | undefined,
  legacyStatus: string,
) {
  return statusEnum ?? toRfqStatusEnum(legacyStatus) ?? legacyStatus;
}

export function preferredQuotationStatus(
  statusEnum: QuotationStatusEnum | null | undefined,
  legacyStatus: string,
) {
  return statusEnum ?? toQuotationStatusEnum(legacyStatus) ?? legacyStatus;
}

export function preferredOrderStatus(
  statusEnum: OrderStatusEnum | null | undefined,
  legacyStatus: string,
) {
  return statusEnum ?? toOrderStatusEnum(legacyStatus) ?? legacyStatus;
}

export function preferredSupplierQuoteStatus(
  statusEnum: SupplierQuoteStatusEnum | null | undefined,
  legacyStatus: string,
) {
  return statusEnum ?? toSupplierQuoteStatusEnum(legacyStatus) ?? legacyStatus;
}

export type TransactionStatusShadowEntity = 'rfq' | 'quotation' | 'order' | 'supplierQuote';

export interface TransactionStatusShadowRecord {
  entity: TransactionStatusShadowEntity;
  id: string;
  legacyStatus: string;
  enumStatus: string | null | undefined;
}

export interface TransactionStatusShadowIssue extends TransactionStatusShadowRecord {
  normalizedLegacyStatus: string | null;
  reason: 'MISSING_SHADOW' | 'INVALID_LEGACY_STATUS' | 'MISMATCH';
}

export interface TransactionStatusShadowReconciliationResult {
  status: 'PASS' | 'FAIL';
  checkedRecords: number;
  missingShadowStatuses: number;
  invalidLegacyStatuses: number;
  mismatchedStatuses: number;
  issues: TransactionStatusShadowIssue[];
}

function normalizeStatusForEntity(entity: TransactionStatusShadowEntity, value: string) {
  switch (entity) {
    case 'rfq':
      return toRfqStatusEnum(value);
    case 'quotation':
      return toQuotationStatusEnum(value);
    case 'order':
      return toOrderStatusEnum(value);
    case 'supplierQuote':
      return toSupplierQuoteStatusEnum(value);
  }
}

export function reconcileTransactionStatusShadows(
  records: TransactionStatusShadowRecord[],
): TransactionStatusShadowReconciliationResult {
  const issues: TransactionStatusShadowIssue[] = [];
  let missingShadowStatuses = 0;
  let invalidLegacyStatuses = 0;
  let mismatchedStatuses = 0;

  for (const record of records) {
    const normalizedLegacyStatus = normalizeStatusForEntity(record.entity, record.legacyStatus);
    const enumStatus = record.enumStatus ?? null;

    if (!normalizedLegacyStatus) {
      invalidLegacyStatuses += 1;
      issues.push({
        ...record,
        enumStatus,
        normalizedLegacyStatus: null,
        reason: 'INVALID_LEGACY_STATUS',
      });
      continue;
    }

    if (!enumStatus) {
      missingShadowStatuses += 1;
      issues.push({
        ...record,
        enumStatus: null,
        normalizedLegacyStatus,
        reason: 'MISSING_SHADOW',
      });
      continue;
    }

    if (enumStatus !== normalizedLegacyStatus) {
      mismatchedStatuses += 1;
      issues.push({
        ...record,
        enumStatus,
        normalizedLegacyStatus,
        reason: 'MISMATCH',
      });
    }
  }

  return {
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    checkedRecords: records.length,
    missingShadowStatuses,
    invalidLegacyStatuses,
    mismatchedStatuses,
    issues,
  };
}

export async function loadTransactionStatusShadowReconciliation() {
  const { default: prisma } = await import('./prisma.js');
  const [rfqs, quotations, orders, supplierQuotes] = await Promise.all([
    prisma.rFQ.findMany({ select: { id: true, status: true, statusEnum: true } }),
    prisma.quotation.findMany({ select: { id: true, status: true, statusEnum: true } }),
    prisma.order.findMany({ select: { id: true, status: true, statusEnum: true } }),
    prisma.supplierQuote.findMany({ select: { id: true, status: true, statusEnum: true } }),
  ]);

  return reconcileTransactionStatusShadows([
    ...rfqs.map((rfq) => ({
      entity: 'rfq' as const,
      id: rfq.id,
      legacyStatus: rfq.status,
      enumStatus: rfq.statusEnum,
    })),
    ...quotations.map((quotation) => ({
      entity: 'quotation' as const,
      id: quotation.id,
      legacyStatus: quotation.status,
      enumStatus: quotation.statusEnum,
    })),
    ...orders.map((order) => ({
      entity: 'order' as const,
      id: order.id,
      legacyStatus: order.status,
      enumStatus: order.statusEnum,
    })),
    ...supplierQuotes.map((supplierQuote) => ({
      entity: 'supplierQuote' as const,
      id: supplierQuote.id,
      legacyStatus: supplierQuote.status,
      enumStatus: supplierQuote.statusEnum,
    })),
  ]);
}
