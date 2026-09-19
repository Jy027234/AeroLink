import crypto from 'node:crypto';
import { generatePDF, generateQuotationHTML, type PdfLineItem, type QuotationPdfData } from './pdfService.js';

/**
 * A render snapshot is the complete, customer-visible input to a document.
 * It is deliberately independent of the live quotation/customer/template
 * rows.  Callers persist the serialized value and its hash before enqueueing
 * any asynchronous delivery.
 */
export const QUOTATION_RENDER_SNAPSHOT_VERSION = 'quotation-render-v1';
export const QUOTATION_PDF_RENDERER_VERSION = 'quotation-pdf-v1';

export type RenderSnapshotSource = {
  quotationId: string;
  customerId: string;
  commercialRevision?: number | null;
  quotationVersion?: number | null;
  capturedAt: string;
};

export type RenderSnapshotTemplate = {
  id: string | null;
  version: number | null;
  hash: string;
  rendererVersion: string;
};

export type QuotationRenderSnapshot = {
  snapshotVersion: typeof QUOTATION_RENDER_SNAPSHOT_VERSION;
  source: RenderSnapshotSource;
  template: RenderSnapshotTemplate;
  renderData: QuotationPdfData;
  snapshotHash: string;
};

export type QuotationRenderSource = {
  id: string;
  quoteNumber: string;
  partNumber: string;
  quantity: unknown;
  unitPrice?: unknown;
  unitPriceDecimal?: unknown;
  totalPrice?: unknown;
  totalPriceDecimal?: unknown;
  validityDays?: unknown;
  saleType?: string | null;
  incoterm?: string | null;
  incotermLocation?: string | null;
  leadTimeDays?: unknown;
  leadTimeBasis?: string | null;
  moq?: unknown;
  mpq?: unknown;
  priceBasis?: string | null;
  taxIncluded?: boolean | null;
  taxRate?: unknown;
  warrantyDays?: unknown;
  warrantyTerms?: string | null;
  packagingRequirement?: string | null;
  shippingMethod?: string | null;
  commonNote?: string | null;
  certificateFiles?: string | null;
  createdAt: Date | string;
  expiryDate: Date | string;
  currency?: string | null;
  lineItemsMode?: boolean | null;
  commercialRevision?: number | null;
  version?: number | null;
};

export type QuotationRenderCustomer = {
  id: string;
  name: string;
};

export type QuotationRenderLine = {
  id?: string | null;
  lineId?: string | null;
  partNumber: string;
  description?: string | null;
  quantity: unknown;
  unitPrice: unknown;
  lineTotal: unknown;
  currency?: string | null;
  // These fields are accepted so callers can pass Prisma line records.  They
  // are intentionally discarded from the customer-facing snapshot.
  costPrice?: unknown;
  margin?: unknown;
  marginAmount?: unknown;
  marginPercent?: unknown;
  costSourceType?: unknown;
  costSourceId?: unknown;
  costSourceReason?: unknown;
  costSourceSnapshotJson?: unknown;
  costSourceCapturedAt?: unknown;
};

export type QuotationRenderTemplate = {
  id?: string | null;
  version?: number | null;
  bodyTemplate?: string | null;
  headerTemplate?: string | null;
  footerTemplate?: string | null;
  hash?: string | null;
};

export type BuildQuotationRenderSnapshotArgs = {
  quotation: QuotationRenderSource;
  customer: QuotationRenderCustomer;
  lines?: readonly QuotationRenderLine[];
  template?: QuotationRenderTemplate | null;
  capturedAt?: Date | string;
};

export type ImmutableDocumentArtifact = {
  filename: string;
  content: Buffer;
  contentType: 'application/pdf';
  sha256: string;
  sizeBytes: number;
  snapshotHash: string;
};

function isDecimalLike(value: object) {
  return typeof (value as { toString?: unknown }).toString === 'function'
    && ((value as { constructor?: { name?: string } }).constructor?.name || '').toLowerCase().includes('decimal');
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && isDecimalLike(value)) return String(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Render snapshot contains a non-finite number');
    }
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function numberValue(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed)) throw new Error('Render snapshot contains an invalid number');
  return parsed;
}

function isoDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Render snapshot contains an invalid date');
  return date.toISOString();
}

function dateOnly(value: Date | string) {
  return isoDate(value).split('T')[0];
}

function splitCertificateFiles(value: string | null | undefined) {
  return value?.split(',').map(item => item.trim()).filter(Boolean);
}

function publicLine(line: QuotationRenderLine): PdfLineItem {
  return {
    ...(line.id || line.lineId ? { lineId: line.id || line.lineId || undefined } : {}),
    partNumber: line.partNumber,
    ...(line.description ? { description: line.description } : {}),
    quantity: numberValue(line.quantity),
    unitPrice: numberValue(line.unitPrice),
    lineTotal: numberValue(line.lineTotal),
    currency: line.currency || 'USD',
  };
}

function templateHash(template: QuotationRenderTemplate | null | undefined) {
  if (template?.hash) return template.hash;
  return sha256(canonicalJson({
    rendererVersion: QUOTATION_PDF_RENDERER_VERSION,
    id: template?.id ?? null,
    version: template?.version ?? null,
    bodyTemplate: template?.bodyTemplate ?? null,
    headerTemplate: template?.headerTemplate ?? null,
    footerTemplate: template?.footerTemplate ?? null,
  }));
}

function hashWithoutDigest(snapshot: Omit<QuotationRenderSnapshot, 'snapshotHash'>) {
  return sha256(canonicalJson(snapshot));
}

/**
 * Builds a customer-facing quotation render snapshot.  Cost, margin and cost
 * source evidence are intentionally accepted only as input compatibility and
 * never copied into renderData.
 */
export function buildQuotationRenderSnapshot(args: BuildQuotationRenderSnapshotArgs): QuotationRenderSnapshot {
  const { quotation, customer, lines, template } = args;
  const lineItemsMode = quotation.lineItemsMode === true;
  if (lineItemsMode && (!lines || lines.length === 0)) {
    throw new Error('多行报价缺少明细，不能创建 PDF 渲染快照');
  }

  const capturedAt = isoDate(args.capturedAt ?? new Date());
  const currency = quotation.currency?.trim().toUpperCase();
  if (currency !== 'USD') {
    throw new Error('报价缺少可核实的 USD 币种，不能创建历史渲染快照');
  }
  const renderData: QuotationPdfData = {
    quoteNumber: quotation.quoteNumber,
    customerName: customer.name,
    partNumber: quotation.partNumber,
    quantity: numberValue(quotation.quantity),
    unitPrice: numberValue(quotation.unitPriceDecimal ?? quotation.unitPrice),
    totalPrice: numberValue(quotation.totalPriceDecimal ?? quotation.totalPrice),
    validityDays: numberValue(quotation.validityDays),
    saleType: quotation.saleType || undefined,
    incoterm: quotation.incoterm || undefined,
    incotermLocation: quotation.incotermLocation || undefined,
    leadTimeDays: quotation.leadTimeDays == null ? undefined : numberValue(quotation.leadTimeDays),
    leadTimeBasis: quotation.leadTimeBasis || undefined,
    moq: quotation.moq == null ? undefined : numberValue(quotation.moq),
    mpq: quotation.mpq == null ? undefined : numberValue(quotation.mpq),
    priceBasis: quotation.priceBasis || undefined,
    taxIncluded: quotation.taxIncluded ?? undefined,
    taxRate: quotation.taxRate == null ? undefined : numberValue(quotation.taxRate),
    warrantyDays: quotation.warrantyDays == null ? undefined : numberValue(quotation.warrantyDays),
    warrantyTerms: quotation.warrantyTerms || undefined,
    packagingRequirement: quotation.packagingRequirement || undefined,
    shippingMethod: quotation.shippingMethod || undefined,
    commonNote: quotation.commonNote || undefined,
    certificateFiles: splitCertificateFiles(quotation.certificateFiles),
    createdAt: isoDate(quotation.createdAt),
    expiryDate: dateOnly(quotation.expiryDate),
    currency,
    ...(lineItemsMode ? {
      lines: lines!.map(line => {
        const lineCurrency = line.currency?.trim().toUpperCase();
        if (!lineCurrency) throw new Error('报价行缺少可核实的 USD 币种，不能创建渲染快照');
        if (lineCurrency !== currency) throw new Error('报价行币种与 USD 报价币种不一致，不能创建渲染快照');
        return publicLine({ ...line, currency: lineCurrency });
      }),
      lineItemsMode: true,
    } : {}),
    includeInternalInfo: false,
  };

  const withoutHash: Omit<QuotationRenderSnapshot, 'snapshotHash'> = {
    snapshotVersion: QUOTATION_RENDER_SNAPSHOT_VERSION,
    source: {
      quotationId: quotation.id,
      customerId: customer.id,
      commercialRevision: quotation.commercialRevision ?? null,
      quotationVersion: quotation.version ?? null,
      capturedAt,
    },
    template: {
      id: template?.id ?? null,
      version: template?.version ?? null,
      hash: templateHash(template),
      rendererVersion: QUOTATION_PDF_RENDERER_VERSION,
    },
    renderData,
  };

  return {
    ...withoutHash,
    snapshotHash: hashWithoutDigest(withoutHash),
  };
}

export function serializeQuotationRenderSnapshot(snapshot: QuotationRenderSnapshot) {
  assertQuotationRenderSnapshot(snapshot);
  return canonicalJson(snapshot);
}

export function parseQuotationRenderSnapshot(value: string): QuotationRenderSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Quotation render snapshot is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Quotation render snapshot must be an object');
  }
  assertQuotationRenderSnapshot(parsed as QuotationRenderSnapshot);
  return parsed as QuotationRenderSnapshot;
}

export function assertQuotationRenderSnapshot(snapshot: QuotationRenderSnapshot) {
  if (snapshot.snapshotVersion !== QUOTATION_RENDER_SNAPSHOT_VERSION) {
    throw new Error('Unsupported quotation render snapshot version');
  }
  if (!snapshot.snapshotHash || !snapshot.source?.quotationId || !snapshot.source?.customerId) {
    throw new Error('Quotation render snapshot is missing immutable source evidence');
  }
  const { snapshotHash: _ignored, ...withoutHash } = snapshot;
  const actualHash = hashWithoutDigest(withoutHash);
  if (actualHash !== snapshot.snapshotHash) {
    throw new Error('Quotation render snapshot hash mismatch');
  }
  if (snapshot.renderData.includeInternalInfo === true) {
    throw new Error('Customer quotation render snapshots cannot contain internal cost information');
  }
  const sensitiveKeys = new Set([
    'costPrice', 'costPriceDecimal', 'margin', 'marginAmount', 'marginPercent',
    'costTotal', 'costTotalDecimal', 'totalCost', 'totalCostDecimal',
    'costSourceType', 'costSourceId', 'costSourceReason', 'costSourceSnapshotJson',
    'costSourceCapturedAt', 'costSourceHash',
  ]);
  for (const key of Object.keys(snapshot.renderData as unknown as Record<string, unknown>)) {
    if (sensitiveKeys.has(key)) {
      throw new Error('Quotation render snapshot contains internal cost information');
    }
  }
  for (const line of snapshot.renderData.lines || []) {
    const record = line as unknown as Record<string, unknown>;
    for (const key of sensitiveKeys) {
      if (key in record) throw new Error('Quotation render snapshot contains internal cost information');
    }
  }
  return snapshot;
}

export function quotationRenderData(snapshot: QuotationRenderSnapshot): QuotationPdfData {
  assertQuotationRenderSnapshot(snapshot);
  return {
    ...snapshot.renderData,
    lines: snapshot.renderData.lines?.map(line => ({ ...line })),
    includeInternalInfo: false,
  };
}

function snapshotFooter(capturedAt: string) {
  // capturedAt is ISO text produced by isoDate(), so this interpolation is
  // deterministic and contains no user-provided HTML.
  return `<div class="footer">AeroLink 航材交易平台 - 生成时间: ${capturedAt}</div>`;
}

/** Render only from the immutable snapshot and return a content hash for storage. */
export async function renderQuotationPdfSnapshot(snapshot: QuotationRenderSnapshot): Promise<ImmutableDocumentArtifact> {
  assertQuotationRenderSnapshot(snapshot);
  const renderData = quotationRenderData(snapshot);
  const content = await generatePDF(generateQuotationHTML(renderData), {
    title: `Quotation-${renderData.quoteNumber}`,
    footer: snapshotFooter(snapshot.source.capturedAt),
  });
  return {
    filename: `${renderData.quoteNumber}.pdf`,
    content,
    contentType: 'application/pdf',
    sha256: sha256(content),
    sizeBytes: content.byteLength,
    snapshotHash: snapshot.snapshotHash,
  };
}

/** Verify a stored artifact before using it for an attachment or download. */
export function assertImmutableDocumentArtifact(
  artifact: Pick<ImmutableDocumentArtifact, 'content' | 'sha256' | 'snapshotHash'>,
  expected: { sha256?: string | null; snapshotHash?: string | null } = {},
) {
  const actualSha256 = sha256(artifact.content);
  if (artifact.sha256 !== actualSha256) throw new Error('Stored document bytes failed integrity check');
  if (expected.sha256 && expected.sha256 !== actualSha256) throw new Error('Stored document hash does not match metadata');
  if (expected.snapshotHash && expected.snapshotHash !== artifact.snapshotHash) throw new Error('Stored document snapshot hash does not match metadata');
  return artifact;
}
