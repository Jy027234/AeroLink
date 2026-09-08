import {
  hasCapability,
  normalizeRole,
  type CapabilityActor,
} from './capabilityPolicy.js';
import { generateQuotationHTML } from './pdfService.js';
import { parseQuotationRenderSnapshot, quotationRenderData, sha256 } from './documentRenderSnapshot.js';

const QUOTATION_PDF_DOCUMENT_TYPE = 'QUOTATION_PDF';

const PUBLIC_SNAPSHOT_KEYS = new Set(['snapshotVersion', 'source', 'template', 'renderData', 'snapshotHash']);
const PUBLIC_SOURCE_KEYS = new Set(['quotationId', 'customerId', 'commercialRevision', 'quotationVersion', 'capturedAt']);
const PUBLIC_TEMPLATE_KEYS = new Set(['id', 'version', 'hash', 'rendererVersion']);
const PUBLIC_RENDER_KEYS = new Set([
  'quoteNumber', 'customerName', 'partNumber', 'quantity', 'unitPrice', 'totalPrice', 'validityDays',
  'saleType', 'incoterm', 'incotermLocation', 'leadTimeDays', 'leadTimeBasis', 'moq', 'mpq', 'priceBasis',
  'taxIncluded', 'taxRate', 'warrantyDays', 'warrantyTerms', 'packagingRequirement', 'shippingMethod',
  'commonNote', 'certificateFiles', 'createdAt', 'expiryDate', 'currency', 'lines', 'lineItemsMode',
  'includeInternalInfo',
]);
const PUBLIC_LINE_KEYS = new Set(['lineId', 'partNumber', 'description', 'quantity', 'unitPrice', 'lineTotal', 'currency']);

export interface DocumentOwnerRelation {
  createdBy: string;
  creator?: { department?: string | null } | null;
}

export interface GeneratedDocumentAccessRecord {
  generatedById: string | null;
  quotationId: string | null;
  orderId: string | null;
  customerId?: string | null;
  documentType?: string | null;
  snapshotHash?: string | null;
  contentSha256?: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: unknown, allowed: ReadonlySet<string>) {
  return isRecord(value) && Object.keys(value).every(key => allowed.has(key));
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown) {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || value === null || isFiniteNumber(value);
}

function hasPublicQuotationSnapshotShape(snapshot: unknown) {
  if (!isRecord(snapshot)
    || !hasOnlyKeys(snapshot, PUBLIC_SNAPSHOT_KEYS)
    || !hasOnlyKeys(snapshot.source, PUBLIC_SOURCE_KEYS)
    || !hasOnlyKeys(snapshot.template, PUBLIC_TEMPLATE_KEYS)
    || !hasOnlyKeys(snapshot.renderData, PUBLIC_RENDER_KEYS)) {
    return false;
  }

  const source = snapshot.source as Record<string, unknown>;
  const template = snapshot.template as Record<string, unknown>;
  const renderData = snapshot.renderData as Record<string, unknown>;
  if (snapshot.snapshotVersion !== 'quotation-render-v1'
    || typeof snapshot.snapshotHash !== 'string'
    || typeof source.quotationId !== 'string'
    || typeof source.customerId !== 'string'
    || typeof source.capturedAt !== 'string'
    || !isOptionalFiniteNumber(source.commercialRevision)
    || !isOptionalFiniteNumber(source.quotationVersion)
    || !isOptionalString(template.id)
    || !isOptionalFiniteNumber(template.version)
    || typeof template.hash !== 'string'
    || template.rendererVersion !== 'quotation-pdf-v1'
    || typeof renderData.quoteNumber !== 'string'
    || typeof renderData.customerName !== 'string'
    || typeof renderData.partNumber !== 'string'
    || !isFiniteNumber(renderData.quantity)
    || !isFiniteNumber(renderData.unitPrice)
    || !isFiniteNumber(renderData.totalPrice)
    || !isFiniteNumber(renderData.validityDays)
    || typeof renderData.createdAt !== 'string'
    || typeof renderData.expiryDate !== 'string'
    || renderData.currency !== 'USD'
    || renderData.includeInternalInfo !== false) {
    return false;
  }

  for (const key of [
    'saleType', 'incoterm', 'incotermLocation', 'leadTimeBasis', 'priceBasis', 'warrantyTerms',
    'packagingRequirement', 'shippingMethod', 'commonNote',
  ]) {
    if (!isOptionalString(renderData[key])) return false;
  }
  for (const key of ['leadTimeDays', 'moq', 'mpq', 'taxRate', 'warrantyDays']) {
    if (!isOptionalFiniteNumber(renderData[key])) return false;
  }
  if (renderData.taxIncluded !== undefined && renderData.taxIncluded !== null && typeof renderData.taxIncluded !== 'boolean') {
    return false;
  }
  if (renderData.certificateFiles !== undefined
    && (!Array.isArray(renderData.certificateFiles) || renderData.certificateFiles.some(value => typeof value !== 'string'))) {
    return false;
  }
  if (renderData.lineItemsMode !== undefined && renderData.lineItemsMode !== true) return false;
  if (renderData.lineItemsMode === true && !Array.isArray(renderData.lines)) return false;
  if (renderData.lines !== undefined) {
    if (!Array.isArray(renderData.lines) || renderData.lineItemsMode !== true || renderData.lines.length === 0) return false;
    for (const line of renderData.lines) {
      if (!isRecord(line) || !hasOnlyKeys(line, PUBLIC_LINE_KEYS)) return false;
      if (typeof line.partNumber !== 'string'
        || !isFiniteNumber(line.quantity)
        || !isFiniteNumber(line.unitPrice)
        || !isFiniteNumber(line.lineTotal)
        || line.currency !== 'USD'
        || !isOptionalString(line.lineId)
        || !isOptionalString(line.description)) {
        return false;
      }
    }
  }
  return true;
}

function isVerifiedPublicQuotationSnapshot(
  document: Pick<GeneratedDocumentAccessRecord, 'documentType' | 'quotationId' | 'customerId' | 'snapshotHash' | 'contentSha256' | 'contentHtml' | 'payloadJson'>,
) {
  if (document.documentType !== QUOTATION_PDF_DOCUMENT_TYPE || !document.quotationId || !document.payloadJson) {
    return false;
  }

  try {
    const snapshot = parseQuotationRenderSnapshot(document.payloadJson);
    if (!hasPublicQuotationSnapshotShape(snapshot)) return false;
    if (snapshot.source.quotationId !== document.quotationId) return false;
    if (document.customerId && snapshot.source.customerId !== document.customerId) return false;
    if (document.snapshotHash && snapshot.snapshotHash !== document.snapshotHash) return false;
    if (!document.contentHtml || generateQuotationHTML(quotationRenderData(snapshot)) !== document.contentHtml) return false;
    if (document.contentSha256 && sha256(document.contentHtml) !== document.contentSha256) return false;
    return true;
  } catch {
    return false;
  }
}

export function containsInternalCommercialData(document: Pick<GeneratedDocumentAccessRecord, 'documentType' | 'quotationId' | 'customerId' | 'snapshotHash' | 'contentSha256' | 'contentHtml' | 'payloadJson'>): boolean {
  if (isVerifiedPublicQuotationSnapshot(document)) return false;
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
