import {
  hasCapability,
  normalizeRole,
  type CapabilityActor,
} from './capabilityPolicy.js';

export interface DocumentOwnerRelation {
  createdBy: string;
  creator?: { department?: string | null } | null;
}

export interface GeneratedDocumentAccessRecord {
  generatedById: string | null;
  quotationId: string | null;
  orderId: string | null;
  contentHtml?: string | null;
  payloadJson?: string | null;
  quotation?: DocumentOwnerRelation | null;
  order?: { quotation?: DocumentOwnerRelation | null } | null;
}

const SAFE_PAYLOAD_KEYS = new Set([
  'customer', 'name', 'contactName', 'email', 'phone', 'address',
  'quotation', 'quoteNumber', 'partNumber', 'quantity', 'unitPrice', 'totalPrice',
  'saleType', 'incoterm', 'incotermLocation', 'leadTimeDays', 'warrantyDays',
  'taxIncluded', 'taxRate', 'packagingRequirement', 'shippingMethod', 'expiryDate',
  'customerConfirmationNote', 'order', 'orderNumber', 'soNumber', 'poNumber',
  'deliveryDate', 'system', 'generatedAt',
]);

// This is a conservative deny signal only. Structured payload keys below are
// the deterministic rule; arbitrary HTML cannot be proven safe by scanning.
const INTERNAL_DOCUMENT_MARKER = /cost(?:price|source)|unitCost|gross[\s-]?margin|margin(?:Percent|Amount)|totalLandCost|importDuty|vatAmount|exchangeCoreCharge|成本|毛利|利润率|单位成本/i;

function payloadContainsUnknownOrSensitiveFields(payloadJson: string | null | undefined): boolean {
  if (!payloadJson) return false;
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some(visit);
      return Object.entries(value).some(([key, child]) => !SAFE_PAYLOAD_KEYS.has(key) || visit(child));
    };
    return visit(payload);
  } catch {
    // An unreadable snapshot cannot be proven safe for a non-cost reader.
    return true;
  }
}

export function containsInternalCommercialData(document: Pick<GeneratedDocumentAccessRecord, 'contentHtml' | 'payloadJson'>): boolean {
  return INTERNAL_DOCUMENT_MARKER.test(document.contentHtml || '')
    || payloadContainsUnknownOrSensitiveFields(document.payloadJson);
}

function canViewDocumentCommercialData(actor: CapabilityActor): boolean {
  return hasCapability(actor, 'quotation', 'view_cost')
    || hasCapability(actor, 'order', 'view_cost')
    || hasCapability(actor, 'inventory', 'view_cost')
    || hasCapability(actor, 'report', 'view_cost');
}

function isDocumentAdministrator(actor: CapabilityActor): boolean {
  const role = normalizeRole(actor.role);
  return role === 'admin';
}

function canReadQuotation(actor: CapabilityActor, quotation: DocumentOwnerRelation | null | undefined) {
  return Boolean(
    quotation
      && hasCapability(actor, 'quotation', 'read', {
        ownerId: quotation.createdBy,
        department: quotation.creator?.department,
      }),
  );
}

function canReadOrder(actor: CapabilityActor, order: GeneratedDocumentAccessRecord['order']) {
  return Boolean(
    order?.quotation
      && hasCapability(actor, 'order', 'read', {
        ownerId: order.quotation.createdBy,
        department: order.quotation.creator?.department,
      }),
  );
}

/**
 * Re-evaluate access from the current quotation/order ownership each time a
 * document is read. Unlinked documents are intentionally limited to their
 * creator and global administrators.
 */
export function canReadGeneratedDocument(
  actor: CapabilityActor,
  document: GeneratedDocumentAccessRecord,
): boolean {
  if (containsInternalCommercialData(document) && !canViewDocumentCommercialData(actor)) {
    return false;
  }

  const isLinked = Boolean(document.quotationId || document.orderId);
  if (!isLinked) {
    return isDocumentAdministrator(actor) || document.generatedById === actor.id;
  }

  if (document.quotationId && !canReadQuotation(actor, document.quotation)) return false;
  if (document.orderId && !canReadOrder(actor, document.order)) return false;
  return true;
}
