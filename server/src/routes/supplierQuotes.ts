import { Router } from 'express';
import { Prisma, type RfqStatusEnum, type SupplierQuoteStatusEnum } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { calculateMoneyTotal, normalizeMoney, preferredMoneyValue } from '../lib/money.js';
import {
  preferredRfqStatus,
  preferredSupplierQuoteStatus,
  toSupplierQuoteStatusEnum,
} from '../lib/transactionStatusShadows.js';
import { supplierQuoteCreateSchema, supplierQuoteUpdateSchema } from '../lib/validation.js';
import prisma from '../lib/prisma.js';
import {
  assertQuotationMatchesRfq,
  supplierQuoteCurrencyStatus,
  VERIFIED_CURRENCY_STATUS,
} from '../lib/commercialCostSource.js';
import { resolveSupplierQuoteSourceBinding } from '../lib/supplierQuoteSourceBinding.js';

const router = Router();

type SupplierQuoteMoneySource = {
  unitPrice: number;
  unitPriceDecimal: Prisma.Decimal | null;
  totalPrice: number;
  totalPriceDecimal: Prisma.Decimal | null;
};

type SupplierQuoteStatusShadow = {
  status: string;
  statusEnum?: SupplierQuoteStatusEnum | null;
};

type SupplierQuoteLegacyComparison = {
  aiScore?: number | null;
  aiRecommendation?: string | null;
};

type SupplierQuoteCurrency = {
  currency?: string | null;
  currencyReviewStatus?: string | null;
};

type RfqStatusShadow = {
  status: string;
  statusEnum?: RfqStatusEnum | null;
};

const supplierQuoteLineSelect = {
  id: true,
  rfqId: true,
  partNumber: true,
  quantity: true,
  alternatePartNumbers: true,
  certificateRequired: true,
  certificateType: true,
  conditionCode: true,
} satisfies Prisma.RfqLineSelect;

const supplierQuoteRfqSelect = {
  id: true,
  partNumber: true,
  quantity: true,
  alternatePartNumbers: true,
  certificateRequired: true,
  certificateType: true,
  conditionCode: true,
} satisfies Prisma.RFQSelect;

type SupplierQuoteComparisonScope = {
  rfqId: string | null;
  rfqLineId: string | null;
  inquiryId: string | null;
  inquiryItemId: string | null;
  allowUnboundLegacyQuotes: boolean;
  partScope: {
    partNumber: string;
    quantity: number;
    alternatePartNumbers?: string | null;
    certificateRequired?: boolean | null;
    certificateType?: string | null;
    conditionCode?: string | null;
  } | null;
};

const supplierQuoteComparisonInclude = {
  supplier: {
    select: {
      id: true,
      name: true,
      level: true,
      performanceScore: true,
      leadTime: true,
    },
  },
  inquiry: { select: { id: true, rfqId: true, supplierId: true } },
  inquiryItem: { select: { id: true, inquiryId: true, rfqLineId: true } },
  sourceDraft: { select: { payloadJson: true } },
} satisfies Prisma.SupplierQuoteInclude;

function compareRequestId(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new AppError(`${fieldName} 必须是非空字符串`, 400, 'BAD_REQUEST');
  }
  return value;
}

function comparisonScopeFromLine(line: {
  id: string;
  rfqId: string;
  partNumber: string;
  quantity: number;
  alternatePartNumbers: string | null;
  certificateRequired: boolean;
  certificateType: string | null;
  conditionCode: string;
}, allowUnboundLegacyQuotes: boolean): SupplierQuoteComparisonScope {
  return {
    rfqId: line.rfqId,
    rfqLineId: line.id,
    inquiryId: null,
    inquiryItemId: null,
    allowUnboundLegacyQuotes,
    partScope: line,
  };
}

async function resolveSupplierQuoteComparisonScope(
  input: { rfqId?: unknown; inquiryId?: unknown; rfqLineId?: unknown; inquiryItemId?: unknown },
): Promise<SupplierQuoteComparisonScope> {
  const rfqIdInput = compareRequestId(input.rfqId, 'rfqId');
  const inquiryIdInput = compareRequestId(input.inquiryId, 'inquiryId');
  const rfqLineIdInput = compareRequestId(input.rfqLineId, 'rfqLineId');
  const inquiryItemIdInput = compareRequestId(input.inquiryItemId, 'inquiryItemId');

  if (!rfqIdInput && !inquiryIdInput && !rfqLineIdInput && !inquiryItemIdInput) {
    throw new AppError('必须提供 rfqLineId 或 inquiryItemId；仅旧版 rfqId/inquiryId 可用于唯一需求行兼容解析', 400, 'BAD_REQUEST');
  }

  const lineById = async (id: string) => {
    const line = await prisma.rfqLine.findUnique({ where: { id }, select: supplierQuoteLineSelect });
    if (!line) throw new AppError('指定的 RFQ 需求行不存在', 404, 'RESOURCE_NOT_FOUND');
    if (rfqIdInput && line.rfqId !== rfqIdInput) {
      throw new AppError('RFQ 需求行不属于当前 RFQ', 409, 'INVALID_RFQ_LINE');
    }
    if (inquiry?.rfqId && inquiry.rfqId !== line.rfqId) {
      throw new AppError('询价单与 RFQ 需求行不一致', 409, 'INVALID_RFQ_LINE');
    }
    if (inquiryIdInput && inquiry && !inquiry.items.some((item) => item.rfqLineId === line.id)) {
      throw new AppError('询价单没有关联该 RFQ 需求行', 409, 'INVALID_RFQ_LINE');
    }
    return line;
  };

  const inquiry = inquiryIdInput
    ? await prisma.inquiry.findUnique({
      where: { id: inquiryIdInput },
      select: {
        id: true,
        rfqId: true,
        supplierId: true,
        items: { select: { id: true, rfqLineId: true, partNumber: true, quantity: true, certificateRequired: true } },
      },
    })
    : null;
  if (inquiryIdInput && !inquiry) {
    throw new AppError('关联询价单不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (inquiry && inquiry.rfqId && rfqIdInput && inquiry.rfqId !== rfqIdInput) {
    throw new AppError('询价单与 RFQ 不一致', 409, 'RESOURCE_CONFLICT');
  }
  if (inquiry && rfqIdInput && !inquiry.rfqId && !inquiry.items.some((item) => item.rfqLineId)) {
    throw new AppError('询价单未绑定该 RFQ，不能只凭两个单据标识进行比较', 409, 'RESOURCE_CONFLICT');
  }

  let requestedItem: {
    id: string;
    inquiryId: string;
    rfqLineId: string | null;
    partNumber: string;
    quantity: number;
    certificateRequired: boolean;
    inquiry: { id: string; rfqId: string | null; supplierId: string };
  } | null = null;
  if (inquiryItemIdInput) {
    requestedItem = await prisma.inquiryItem.findUnique({
      where: { id: inquiryItemIdInput },
      select: {
        id: true,
        inquiryId: true,
        rfqLineId: true,
        partNumber: true,
        quantity: true,
        certificateRequired: true,
        inquiry: { select: { id: true, rfqId: true, supplierId: true } },
      },
    });
    if (!requestedItem) throw new AppError('指定的询价需求项不存在', 404, 'RESOURCE_NOT_FOUND');
    if (inquiryIdInput && requestedItem.inquiryId !== inquiryIdInput) {
      throw new AppError('询价需求项不属于当前询价单', 409, 'RESOURCE_CONFLICT');
    }
    if (rfqIdInput && requestedItem.inquiry.rfqId && requestedItem.inquiry.rfqId !== rfqIdInput) {
      throw new AppError('询价需求项与 RFQ 不一致', 409, 'RESOURCE_CONFLICT');
    }
    if (rfqLineIdInput && requestedItem.rfqLineId !== rfqLineIdInput) {
      throw new AppError('询价需求项与 RFQ 需求行不一致', 409, 'INVALID_RFQ_LINE');
    }
    if (requestedItem.rfqLineId) {
      const line = await lineById(requestedItem.rfqLineId);
      if (requestedItem.inquiry.rfqId && requestedItem.inquiry.rfqId !== line.rfqId) {
        throw new AppError('询价需求项与 RFQ 需求行不一致', 409, 'INVALID_RFQ_LINE');
      }
      return comparisonScopeFromLine(line, false);
    }
    if (rfqLineIdInput) {
      throw new AppError('询价需求项缺少 RFQ 需求行，不能安全绑定', 409, 'LINE_ID_REQUIRED');
    }
    return {
      rfqId: requestedItem.inquiry.rfqId,
      rfqLineId: null,
      inquiryId: requestedItem.inquiryId,
      inquiryItemId: requestedItem.id,
      allowUnboundLegacyQuotes: false,
      partScope: {
        partNumber: requestedItem.partNumber,
        quantity: requestedItem.quantity,
        certificateRequired: requestedItem.certificateRequired,
      },
    };
  }

  if (rfqLineIdInput) {
    const line = await lineById(rfqLineIdInput);
    const siblingLines = await prisma.rfqLine.findMany({
      where: { rfqId: line.rfqId },
      select: supplierQuoteLineSelect,
    });
    return comparisonScopeFromLine(line, siblingLines.length === 1);
  }

  const effectiveRfqId = rfqIdInput || inquiry?.rfqId || null;
  if (inquiry) {
    const linkedLineIds = new Set(inquiry.items.map((item) => item.rfqLineId).filter((id): id is string => Boolean(id)));
    const unboundItems = inquiry.items.filter((item) => !item.rfqLineId);
    if (linkedLineIds.size === 1 && unboundItems.length === 0) {
      const [lineId] = linkedLineIds;
      const line = await lineById(lineId);
      return comparisonScopeFromLine(line, false);
    }
    if (linkedLineIds.size > 1 || (linkedLineIds.size > 0 && unboundItems.length > 0) || unboundItems.length > 1) {
      throw new AppError('该 RFQ/询价单包含多条需求行，请提供 rfqLineId 或 inquiryItemId', 409, 'LINE_ID_REQUIRED');
    }
    if (unboundItems.length === 1 && !effectiveRfqId) {
      const [item] = unboundItems;
      return {
        rfqId: null,
        rfqLineId: null,
        inquiryId: inquiry.id,
        inquiryItemId: item.id,
        allowUnboundLegacyQuotes: false,
        partScope: {
          partNumber: item.partNumber,
          quantity: item.quantity,
          certificateRequired: item.certificateRequired,
        },
      };
    }
  }

  if (effectiveRfqId) {
    const lines = await prisma.rfqLine.findMany({
      where: { rfqId: effectiveRfqId },
      select: supplierQuoteLineSelect,
    });
    if (lines.length > 1) {
      throw new AppError('该 RFQ 包含多条需求行，请提供 rfqLineId 或 inquiryItemId', 409, 'LINE_ID_REQUIRED');
    }
    if (lines.length === 1) {
      return comparisonScopeFromLine(lines[0], true);
    }
    const rfq = await prisma.rFQ.findUnique({ where: { id: effectiveRfqId }, select: supplierQuoteRfqSelect });
    if (!rfq) throw new AppError('关联 RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
    return {
      rfqId: rfq.id,
      rfqLineId: null,
      inquiryId: inquiry?.id ?? null,
      inquiryItemId: inquiry?.items[0]?.id ?? null,
      allowUnboundLegacyQuotes: false,
      partScope: rfq,
    };
  }

  throw new AppError('无法从该询价单唯一解析需求行，请提供 rfqLineId 或 inquiryItemId', 409, 'LINE_ID_REQUIRED');
}

function quoteHasConsistentComparisonBinding(
  quote: {
    rfqId: string | null;
    rfqLineId: string | null;
    inquiryId: string | null;
    inquiryItemId: string | null;
    supplierId: string;
    partNumber: string;
    quantity: number;
    inquiry?: { id: string; rfqId: string | null; supplierId: string } | null;
    inquiryItem?: { id: string; inquiryId: string; rfqLineId: string | null } | null;
  },
  scope: SupplierQuoteComparisonScope,
) {
  if (scope.rfqLineId) {
    if (quote.rfqId !== scope.rfqId) return false;
    if (quote.rfqLineId !== scope.rfqLineId && !(scope.allowUnboundLegacyQuotes && quote.rfqLineId === null)) return false;
    if (quote.inquiryId && (
      !quote.inquiry || quote.inquiry.id !== quote.inquiryId || quote.inquiry.supplierId !== quote.supplierId ||
      (quote.inquiry.rfqId !== null && quote.inquiry.rfqId !== scope.rfqId)
    )) return false;
    if (quote.inquiryItemId && (
      !quote.inquiryItem || quote.inquiryItem.id !== quote.inquiryItemId ||
      quote.inquiryItem.inquiryId !== quote.inquiryId ||
      (quote.rfqLineId === scope.rfqLineId && quote.inquiryItem.rfqLineId !== scope.rfqLineId) ||
      (quote.rfqLineId === null && quote.inquiryItem.rfqLineId !== null &&
        (!scope.allowUnboundLegacyQuotes || quote.inquiryItem.rfqLineId !== scope.rfqLineId))
    )) return false;
  } else if (scope.inquiryItemId) {
    if (quote.rfqId !== scope.rfqId || quote.inquiryId !== scope.inquiryId || quote.inquiryItemId !== scope.inquiryItemId) return false;
    if (!quote.inquiry || quote.inquiry.id !== quote.inquiryId || quote.inquiry.supplierId !== quote.supplierId) return false;
    if (quote.inquiryItem && (
      quote.inquiryItem.id !== scope.inquiryItemId || quote.inquiryItem.inquiryId !== quote.inquiryId ||
      quote.inquiryItem.rfqLineId !== null
    )) return false;
  } else {
    if (quote.rfqId !== scope.rfqId || quote.rfqLineId !== null || quote.inquiryId !== scope.inquiryId) return false;
    if (quote.inquiryId && (
      !quote.inquiry || quote.inquiry.id !== quote.inquiryId || quote.inquiry.supplierId !== quote.supplierId
    )) return false;
    if (quote.inquiryItemId) return false;
  }

  if (scope.partScope) {
    try {
      assertQuotationMatchesRfq(quote.partNumber, quote.quantity, scope.partScope);
    } catch {
      return false;
    }
  }
  return true;
}

function supplierQuoteStatus(quote: SupplierQuoteStatusShadow) {
  return preferredSupplierQuoteStatus(quote.statusEnum, quote.status);
}

function supplierQuoteComparisonStatusIsAvailable(status: string) {
  const normalized = status.trim().toLowerCase();
  // Pending quotes are live offers awaiting a decision; accepted quotes remain
  // valid commercial terms. Rejected and expired records are historical only.
  return normalized === 'pending' || normalized === 'accepted';
}

type SupplierQuoteDraftTerms = {
  condition: unknown | null;
  conditionStatus: 'known' | 'unknown';
  certificate: unknown | null;
  certificateStatus: 'provided' | 'missing' | 'unknown';
  taxIncluded: boolean | null;
  freightIncluded: boolean | null;
  incoterm: string | null;
};

function supplierQuoteDraftTerms(payloadJson: string | null | undefined, itemKey: string | null | undefined): SupplierQuoteDraftTerms {
  const unknownTerms: SupplierQuoteDraftTerms = {
    condition: null,
    conditionStatus: 'unknown',
    certificate: null,
    certificateStatus: 'unknown',
    taxIncluded: null,
    freightIncluded: null,
    incoterm: null,
  };
  if (!payloadJson || !itemKey) return unknownTerms;

  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { items?: unknown }).items)) {
      return unknownTerms;
    }
    const matches = ((payload as { items: unknown[] }).items).filter((item) =>
      item && typeof item === 'object' && (item as { itemKey?: unknown }).itemKey === itemKey,
    );
    if (matches.length !== 1) return unknownTerms;

    const item = matches[0] as Record<string, unknown>;
    const hasCondition = Object.prototype.hasOwnProperty.call(item, 'condition');
    const hasCertificate = Object.prototype.hasOwnProperty.call(item, 'certificate');
    const condition = hasCondition ? item.condition ?? null : null;
    const certificate = hasCertificate ? item.certificate ?? null : null;
    const taxIncluded = typeof item.taxIncluded === 'boolean' ? item.taxIncluded : null;
    const freightIncluded = typeof item.freightIncluded === 'boolean' ? item.freightIncluded : null;
    const incoterm = typeof item.incoterm === 'string' && item.incoterm.trim().length > 0
      ? item.incoterm.trim()
      : null;
    const conditionStatus = typeof condition === 'string' && condition.trim().length > 0 ? 'known' : 'unknown';

    let certificateStatus: SupplierQuoteDraftTerms['certificateStatus'] = 'unknown';
    if (certificate === false || (Array.isArray(certificate) && certificate.length === 0)
      || (typeof certificate === 'string' && certificate.trim().length === 0)) {
      certificateStatus = 'missing';
    } else if (certificate === true
      || (typeof certificate === 'string' && certificate.trim().length > 0)
      || (Array.isArray(certificate) && certificate.length > 0)) {
      certificateStatus = 'provided';
    }

    return { condition, conditionStatus, certificate, certificateStatus, taxIncluded, freightIncluded, incoterm };
  } catch {
    return unknownTerms;
  }
}

function supplierQuoteCommercialBasis(terms: SupplierQuoteDraftTerms) {
  const condition = terms.conditionStatus === 'known' && typeof terms.condition === 'string'
    ? terms.condition.trim().toUpperCase()
    : 'UNKNOWN';
  let certificate: unknown;
  if (terms.certificateStatus === 'unknown') {
    certificate = ['UNKNOWN'];
  } else if (terms.certificateStatus === 'missing') {
    certificate = ['MISSING'];
  } else if (terms.certificate === true) {
    certificate = ['PROVIDED'];
  } else if (Array.isArray(terms.certificate)) {
    certificate = ['PROVIDED', ...terms.certificate.map((item) => String(item).trim()).sort()];
  } else if (typeof terms.certificate === 'string') {
    certificate = ['PROVIDED', terms.certificate.trim()];
  } else {
    certificate = ['PROVIDED'];
  }
  const incoterm = terms.incoterm?.trim().toUpperCase() ?? 'UNKNOWN';
  const key = JSON.stringify([
    condition,
    certificate,
    terms.taxIncluded ?? 'UNKNOWN',
    terms.freightIncluded ?? 'UNKNOWN',
    incoterm,
  ]);
  const certificateLabel = terms.certificateStatus === 'unknown'
    ? 'unknown'
    : terms.certificateStatus === 'missing'
      ? 'missing'
      : Array.isArray(terms.certificate)
        ? terms.certificate.map((item) => String(item).trim()).sort().join(', ') || 'provided'
        : typeof terms.certificate === 'string'
          ? terms.certificate.trim() || 'provided'
          : 'provided';
  const displayValue = (value: boolean | null) => value === null ? 'unknown' : value ? 'included' : 'excluded';
  const label = [
    `Condition ${condition}`,
    `Certificate ${certificateLabel}`,
    `Tax ${displayValue(terms.taxIncluded)}`,
    `Freight ${displayValue(terms.freightIncluded)}`,
    `Incoterm ${incoterm}`,
  ].join(' · ');

  return {
    key,
    label,
    terms: {
      condition: terms.condition,
      certificate: terms.certificate,
      taxIncluded: terms.taxIncluded,
      freightIncluded: terms.freightIncluded,
      incoterm: terms.incoterm,
    },
  };
}

function projectRfqStatus<T extends RfqStatusShadow>(rfq: T | null) {
  if (!rfq) {
    return rfq;
  }

  const { status, statusEnum, ...rest } = rfq;
  return {
    ...rest,
    status: preferredRfqStatus(statusEnum, status),
  };
}

function supplierQuoteUnitPrice(quote: Pick<SupplierQuoteMoneySource, 'unitPrice' | 'unitPriceDecimal'>) {
  return preferredMoneyValue(quote.unitPriceDecimal, quote.unitPrice) ?? 0;
}

function supplierQuoteTotalPrice(quote: Pick<SupplierQuoteMoneySource, 'totalPrice' | 'totalPriceDecimal'>) {
  return preferredMoneyValue(quote.totalPriceDecimal, quote.totalPrice) ?? 0;
}

function projectSupplierQuoteMoney<
  T extends SupplierQuoteMoneySource & SupplierQuoteStatusShadow & SupplierQuoteLegacyComparison & SupplierQuoteCurrency,
>(quote: T) {
  const {
    unitPriceDecimal,
    totalPriceDecimal,
    unitPrice,
    totalPrice,
    status,
    statusEnum,
    aiScore: _legacyAiScore,
    aiRecommendation: _legacyAiRecommendation,
    currency: rawCurrency,
    currencyReviewStatus,
    ...rest
  } = quote;
  return {
    ...rest,
    currency: rawCurrency || null,
    currencyStatus: supplierQuoteCurrencyStatus(rawCurrency, currencyReviewStatus),
    status: supplierQuoteStatus({ status, statusEnum }),
    unitPrice: preferredMoneyValue(unitPriceDecimal, unitPrice) ?? 0,
    totalPrice: preferredMoneyValue(totalPriceDecimal, totalPrice) ?? 0,
    // Legacy aiScore/aiRecommendation values did not retain the inputs or
    // version needed to audit them. Do not project them as current analysis.
    ruleScore: null,
  };
}

router.get(
  '/',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const { rfqId, inquiryId, status, partNumber } = req.query;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.SupplierQuoteWhereInput = {};
    if (rfqId) where.rfqId = rfqId.toString();
    if (inquiryId) where.inquiryId = inquiryId.toString();
    if (status) where.status = status.toString();
    if (partNumber) where.partNumber = { contains: partNumber.toString() };

    const [quotes, total] = await Promise.all([
      prisma.supplierQuote.findMany({
        where,
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              level: true,
              performanceScore: true,
              contactName: true,
              email: true,
            },
          },
        },
        orderBy: [
          { isWinner: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip,
        take: limit,
      }),
      prisma.supplierQuote.count({ where }),
    ]);

    res.json({
      success: true,
      data: quotes.map((q) => ({
        id: q.id,
        rfqId: q.rfqId,
        rfqLineId: q.rfqLineId,
        inquiryId: q.inquiryId,
        inquiryItemId: q.inquiryItemId,
        partNumber: q.partNumber,
        description: q.description,
        quantity: q.quantity,
        unitPrice: supplierQuoteUnitPrice(q),
         totalPrice: supplierQuoteTotalPrice(q),
         currency: q.currency || null,
         currencyStatus: supplierQuoteCurrencyStatus(q.currency, q.currencyReviewStatus),
        leadTimeDays: q.leadTimeDays,
        validUntil: q.validUntil?.toISOString() || null,
        notes: q.notes,
        status: supplierQuoteStatus(q),
        isWinner: q.isWinner,
        ruleScore: null,
        createdAt: q.createdAt.toISOString(),
        supplier: {
          id: q.supplier.id,
          name: q.supplier.name,
          level: q.supplier.level,
          performanceScore: q.supplier.performanceScore,
          contactName: q.supplier.contactName,
          contactEmail: q.supplier.email,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

router.get(
  '/:id',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const quote = await prisma.supplierQuote.findUnique({
      where: { id: req.params.id },
      include: {
        supplier: true,
        rfq: true,
        inquiry: true,
      },
    });

    if (!quote) {
      throw new AppError('供应商报价不存在', 404);
    }

    res.json({
      success: true,
      data: {
        ...projectSupplierQuoteMoney(quote),
        rfq: projectRfqStatus(quote.rfq),
      },
    });
  })
);

router.post(
  '/',
  requireCapability('supplier_quote', 'create'),
  validateBody(supplierQuoteCreateSchema),
  asyncHandler(async (req, res) => {
    const {
      rfqId,
      rfqLineId,
      inquiryId,
      inquiryItemId,
      supplierId,
      partNumber,
      description,
      quantity,
      unitPrice,
      currency,
      leadTimeDays,
      validUntil,
      notes,
    } = req.body;
    const unitPriceDecimal = normalizeMoney(unitPrice);
    const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, quantity);
    const quote = await prisma.$transaction(async (tx) => {
      const source = await resolveSupplierQuoteSourceBinding(tx, {
        rfqId,
        rfqLineId,
        inquiryId,
        inquiryItemId,
        supplierId,
        partNumber,
        quantity,
      });
      return tx.supplierQuote.create({
        data: {
          rfqId: source.rfqId,
          rfqLineId: source.rfqLineId,
          inquiryId: source.inquiryId,
          inquiryItemId: source.inquiryItemId,
          supplierId,
          partNumber,
          description,
          quantity,
          unitPrice: unitPriceDecimal.toNumber(),
          unitPriceDecimal,
          totalPrice: totalPriceDecimal.toNumber(),
          totalPriceDecimal,
          leadTimeDays,
          validUntil: validUntil ? new Date(validUntil) : null,
          notes,
          status: 'pending',
          statusEnum: toSupplierQuoteStatusEnum('pending')!,
          currency,
          currencyReviewStatus: VERIFIED_CURRENCY_STATUS,
        },
      });
    });

    res.status(201).json({
      success: true,
      data: projectSupplierQuoteMoney(quote),
    });
  })
);

router.put(
  '/:id',
  requireCapability('supplier_quote', 'update'),
  validateBody(supplierQuoteUpdateSchema),
  asyncHandler(async (req, res) => {
    const {
      unitPrice,
      quantity,
      currency,
      leadTimeDays,
      validUntil,
      notes,
      status,
      isWinner,
      rfqId,
      rfqLineId,
      inquiryId,
      inquiryItemId,
      partNumber,
    } = req.body;

    const existing = await prisma.supplierQuote.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('供应商报价不存在', 404);
    }

    const identityChanges = [
      ['rfqId', rfqId, existing.rfqId],
      ['rfqLineId', rfqLineId, existing.rfqLineId],
      ['inquiryId', inquiryId, existing.inquiryId],
      ['inquiryItemId', inquiryItemId, existing.inquiryItemId],
      ['partNumber', partNumber, existing.partNumber],
    ].filter(([, requested, current]) => requested !== undefined && requested !== current);
    if (identityChanges.length > 0) {
      const [quotationReference, quotationLineReference] = await Promise.all([
        prisma.quotation.findFirst({
          where: { costSourceType: 'SUPPLIER_QUOTE', costSourceId: existing.id },
          select: { id: true },
        }),
        prisma.quotationLine.findFirst({
          where: { sourceSupplierQuoteId: existing.id },
          select: { id: true },
        }),
      ]);
      if (quotationReference || quotationLineReference) {
        throw new AppError('供应商报价已被报价或报价行引用，不能修改来源身份', 409, 'STATE_CONFLICT');
      }
      throw new AppError('供应商报价来源身份不可修改，请新建供应商报价', 409, 'STATE_CONFLICT');
    }

    if (quantity !== undefined && existing.rfqId) {
      const currentScope = existing.rfqLineId
        ? await prisma.rfqLine.findUnique({ where: { id: existing.rfqLineId }, select: supplierQuoteLineSelect })
        : await prisma.rFQ.findUnique({ where: { id: existing.rfqId }, select: supplierQuoteRfqSelect });
      if (!currentScope) {
        throw new AppError('供应商报价来源 RFQ 需求范围不存在', 409, 'RESOURCE_CONFLICT');
      }
      assertQuotationMatchesRfq(existing.partNumber, quantity, currentScope);
      if (existing.inquiryItemId) {
        const currentItem = await prisma.inquiryItem.findUnique({ where: { id: existing.inquiryItemId }, select: { quantity: true } });
        if (!currentItem || quantity > currentItem.quantity) {
          throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
        }
      }
    }

    const updateData: Prisma.SupplierQuoteUpdateInput = {};
    const unitPriceDecimal = unitPrice === undefined ? undefined : normalizeMoney(unitPrice);
    const nextQuantity = quantity ?? existing.quantity;
    if (unitPriceDecimal) {
      updateData.unitPrice = unitPriceDecimal.toNumber();
      updateData.unitPriceDecimal = unitPriceDecimal;
    }
    if (currency !== undefined) {
      updateData.currency = currency;
      updateData.currencyReviewStatus = VERIFIED_CURRENCY_STATUS;
    }
    if (leadTimeDays !== undefined) updateData.leadTimeDays = leadTimeDays;
    if (validUntil !== undefined) updateData.validUntil = new Date(validUntil);
    if (notes !== undefined) updateData.notes = notes;
    if (status !== undefined) {
      const statusEnum = toSupplierQuoteStatusEnum(status);
      if (!statusEnum) {
        throw new AppError('供应商报价状态无效', 400, 'BAD_REQUEST');
      }
      updateData.status = statusEnum;
      updateData.statusEnum = statusEnum;
    }
    if (isWinner !== undefined) updateData.isWinner = isWinner;

    if (quantity !== undefined) updateData.quantity = quantity;
    if (unitPriceDecimal || quantity !== undefined) {
      const nextUnitPriceDecimal = unitPriceDecimal ?? normalizeMoney(preferredMoneyValue(existing.unitPriceDecimal, existing.unitPrice) ?? 0);
      const totalPriceDecimal = calculateMoneyTotal(nextUnitPriceDecimal, nextQuantity);
      updateData.totalPrice = totalPriceDecimal.toNumber();
      updateData.totalPriceDecimal = totalPriceDecimal;
    }

    const quote = await prisma.supplierQuote.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({
      success: true,
      data: projectSupplierQuoteMoney(quote),
    });
  })
);

router.delete(
  '/:id',
  requireCapability('supplier_quote', 'delete'),
  asyncHandler(async (req, res) => {
    const quote = await prisma.supplierQuote.findUnique({
      where: { id: req.params.id },
    });

    if (!quote) {
      throw new AppError('供应商报价不存在', 404);
    }

    await prisma.supplierQuote.delete({
      where: { id: req.params.id },
    });

    res.json({
      success: true,
      message: '供应商报价已删除',
    });
  })
);

async function assertWinnerQuoteSource(
  tx: Prisma.TransactionClient,
  quote: {
    rfqId: string | null;
    rfqLineId: string | null;
    inquiryId: string | null;
    inquiryItemId: string | null;
    supplierId: string;
    partNumber: string;
    quantity: number;
  },
  expectedRfqId: string | null,
  expectedRfqLineId: string | null,
) {
  if (quote.inquiryId) {
    const inquiry = await tx.inquiry.findUnique({
      where: { id: quote.inquiryId },
      select: { id: true, rfqId: true, supplierId: true },
    });
    if (!inquiry || inquiry.supplierId !== quote.supplierId || (inquiry.rfqId && expectedRfqId && inquiry.rfqId !== expectedRfqId)) {
      throw new AppError('供应商报价的询价来源与 RFQ 或供应商不一致，不能标记中选', 409, 'RESOURCE_CONFLICT');
    }
  }
  if (quote.inquiryItemId) {
    const item = await tx.inquiryItem.findUnique({
      where: { id: quote.inquiryItemId },
      select: {
        id: true,
        inquiryId: true,
        rfqLineId: true,
        partNumber: true,
        quantity: true,
        inquiry: { select: { id: true, rfqId: true, supplierId: true } },
      },
    });
    if (
      !item || item.inquiryId !== quote.inquiryId || item.inquiry.supplierId !== quote.supplierId ||
      (item.inquiry.rfqId && expectedRfqId && item.inquiry.rfqId !== expectedRfqId) ||
      (expectedRfqLineId && item.rfqLineId !== expectedRfqLineId &&
        !(quote.rfqLineId === null && item.rfqLineId === null))
    ) {
      throw new AppError('供应商报价与询价需求项来源不一致，不能标记中选', 409, 'RESOURCE_CONFLICT');
    }
    if (item.rfqLineId) {
      const itemLine = await tx.rfqLine.findUnique({ where: { id: item.rfqLineId }, select: supplierQuoteLineSelect });
      if (!itemLine || (expectedRfqId && itemLine.rfqId !== expectedRfqId) ||
        (expectedRfqLineId && itemLine.id !== expectedRfqLineId)) {
        throw new AppError('供应商报价的询价需求项不属于中选需求行', 409, 'INVALID_RFQ_LINE');
      }
    }
  }
}

async function resolveWinnerClearScope(
  tx: Prisma.TransactionClient,
  quote: {
    rfqId: string | null;
    rfqLineId: string | null;
    inquiryId: string | null;
    inquiryItemId: string | null;
    supplierId: string;
    partNumber: string;
    quantity: number;
  },
): Promise<Prisma.SupplierQuoteWhereInput> {
  if (quote.rfqLineId) {
    const line = await tx.rfqLine.findUnique({ where: { id: quote.rfqLineId }, select: supplierQuoteLineSelect });
    if (!line || quote.rfqId !== line.rfqId) {
      throw new AppError('供应商报价与 RFQ 需求行来源不一致，不能标记中选', 409, 'INVALID_RFQ_LINE');
    }
    assertQuotationMatchesRfq(quote.partNumber, quote.quantity, line);
    await assertWinnerQuoteSource(tx, quote, line.rfqId, line.id);
    const siblingLines = await tx.rfqLine.findMany({ where: { rfqId: line.rfqId }, select: supplierQuoteLineSelect });
    if (siblingLines.length === 1 && siblingLines[0].id === line.id) {
      // A historical quote for a one-line RFQ may predate rfqLineId. It still
      // represents this same line, so selecting a bound quote must clear both
      // shapes in the same transaction. Multi-line RFQs remain ID-only.
      return { rfqId: line.rfqId, OR: [{ rfqLineId: line.id }, { rfqLineId: null }] };
    }
    return { rfqLineId: line.id };
  }

  if (quote.rfqId) {
    const rfq = await tx.rFQ.findUnique({ where: { id: quote.rfqId }, select: supplierQuoteRfqSelect });
    if (!rfq) throw new AppError('供应商报价来源 RFQ 不存在', 409, 'RESOURCE_CONFLICT');
    const lines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, select: supplierQuoteLineSelect });
    if (lines.length > 1) {
      throw new AppError('多行 RFQ 的报价没有需求行绑定，不能标记中选', 409, 'LINE_ID_REQUIRED');
    }
    const line = lines[0];
    assertQuotationMatchesRfq(quote.partNumber, quote.quantity, line ?? rfq);
    await assertWinnerQuoteSource(tx, quote, rfq.id, line?.id ?? null);
    if (line) {
      return { rfqId: rfq.id, OR: [{ rfqLineId: line.id }, { rfqLineId: null }] };
    }
    return { rfqId: rfq.id, rfqLineId: null };
  }

  if (quote.inquiryItemId && quote.inquiryId) {
    await assertWinnerQuoteSource(tx, quote, null, null);
    return { inquiryId: quote.inquiryId, inquiryItemId: quote.inquiryItemId };
  }

  if (quote.inquiryId) {
    const inquiry = await tx.inquiry.findUnique({
      where: { id: quote.inquiryId },
      select: { id: true, rfqId: true, supplierId: true },
    });
    if (!inquiry || inquiry.supplierId !== quote.supplierId) {
      throw new AppError('供应商报价的询价来源与供应商不一致，不能标记中选', 409, 'RESOURCE_CONFLICT');
    }
    const lines = inquiry.rfqId
      ? await tx.rfqLine.findMany({ where: { rfqId: inquiry.rfqId }, select: supplierQuoteLineSelect })
      : [];
    if (lines.length > 1) {
      throw new AppError('多行 RFQ 的报价没有需求行绑定，不能标记中选', 409, 'LINE_ID_REQUIRED');
    }
    if (lines.length === 1) {
      assertQuotationMatchesRfq(quote.partNumber, quote.quantity, lines[0]);
      await assertWinnerQuoteSource(tx, quote, inquiry.rfqId, null);
      return { inquiryId: inquiry.id, OR: [{ rfqLineId: lines[0].id }, { rfqLineId: null }] };
    }
    const items = await tx.inquiryItem.findMany({
      where: { inquiryId: inquiry.id },
      select: { id: true, rfqLineId: true, partNumber: true, quantity: true },
    });
    if (items.length === 0) {
      throw new AppError('询价单缺少可复核的需求项，不能安全标记中选', 409, 'LINE_ID_REQUIRED');
    }
    const itemScopes = new Set(items.map((item) => item.rfqLineId || item.id));
    if (itemScopes.size > 1) {
      throw new AppError('询价单包含多条需求项，报价没有需求行绑定，不能标记中选', 409, 'LINE_ID_REQUIRED');
    }
    const onlyItemLineId = items[0].rfqLineId;
    if (onlyItemLineId) {
      const itemLine = await tx.rfqLine.findUnique({ where: { id: onlyItemLineId }, select: supplierQuoteLineSelect });
      if (!itemLine || (inquiry.rfqId && itemLine.rfqId !== inquiry.rfqId) || quote.rfqId !== itemLine.rfqId) {
        throw new AppError('供应商报价与询价需求项的 RFQ 来源不一致', 409, 'INVALID_RFQ_LINE');
      }
      assertQuotationMatchesRfq(quote.partNumber, quote.quantity, itemLine);
      await assertWinnerQuoteSource(tx, quote, itemLine.rfqId, null);
      return { rfqLineId: itemLine.id };
    }
    await assertWinnerQuoteSource(tx, quote, inquiry.rfqId, null);
    return { inquiryId: inquiry.id, inquiryItemId: null };
  }

  throw new AppError('供应商报价缺少可复核的 RFQ 或询价需求行来源，不能标记中选', 409, 'LINE_ID_REQUIRED');
}

router.post(
  '/compare',
  requireCapability('supplier_quote', 'update'),
  asyncHandler(async (req, res) => {
    const scope = await resolveSupplierQuoteComparisonScope(req.body ?? {});
    const where: Prisma.SupplierQuoteWhereInput = scope.rfqLineId
      ? {
        rfqId: scope.rfqId,
        OR: scope.allowUnboundLegacyQuotes
          ? [{ rfqLineId: scope.rfqLineId }, { rfqLineId: null }]
          : [{ rfqLineId: scope.rfqLineId }],
      }
      : scope.inquiryItemId
        ? { rfqId: scope.rfqId, inquiryId: scope.inquiryId, inquiryItemId: scope.inquiryItemId }
        : { rfqId: scope.rfqId, rfqLineId: null, inquiryId: scope.inquiryId };

    const loadedQuotes = await prisma.supplierQuote.findMany({
      where,
      include: supplierQuoteComparisonInclude,
    });
    const quotes = loadedQuotes.filter((quote) => quoteHasConsistentComparisonBinding(quote, scope));
    const comparisonTime = new Date();
    const asOf = comparisonTime.toISOString();
    const requiredQuantity = scope.partScope?.quantity ?? null;
    const baseMetadata = {
      source: 'AeroLink supplier quote and supplier master records',
      algorithmVersion: 'supplier-quote-rule-v3',
      asOf,
      decisionBoundary: '不推测质量、响应速度、适航资质、可供货量、外部市场价格或客户偏好；规则排序仅供人工复核，不构成中选建议。',
    };

    if (quotes.length === 0) {
      res.json({
        success: true,
        data: {
          rfqId: scope.rfqId,
          rfqLineId: scope.rfqLineId,
          inquiryId: scope.inquiryId,
          inquiryItemId: scope.inquiryItemId,
          quotes: [],
          partNumberGroups: [],
          topRanked: null,
          summary: {
            totalQuotes: 0,
            comparableQuoteCount: 0,
            expiredQuoteCount: 0,
            requiredQuantity,
            bestAvailableQuantity: 0,
            remainingQuantityGap: requiredQuantity,
            lowestPrice: null,
            highestPrice: null,
            averagePrice: null,
          },
          metadata: {
            ...baseMetadata,
            status: 'unavailable',
            sampleSize: 0,
            totalQuoteCount: 0,
            excludedQuoteCount: 0,
            expiredQuoteCount: 0,
            reason: '尚无该需求行的来源一致供应商报价，无法进行规则排序。',
          },
        },
      });
      return;
    }

    const partNumberBuckets = new Map<string, typeof quotes>();
    for (const quote of quotes) {
      const bucket = partNumberBuckets.get(quote.partNumber) ?? [];
      bucket.push(quote);
      partNumberBuckets.set(quote.partNumber, bucket);
    }

    const partNumberGroups = [...partNumberBuckets.entries()].map(([partNumber, groupQuotes]) => {
      const quoteFacts = groupQuotes.map((quote) => {
        const status = supplierQuoteStatus(quote);
        const isExpired = status.toLowerCase() === 'expired'
          || Boolean(quote.validUntil && quote.validUntil.getTime() <= comparisonTime.getTime());
        const currencyStatus = supplierQuoteCurrencyStatus(quote.currency, quote.currencyReviewStatus);
        const statusAvailable = supplierQuoteComparisonStatusIsAvailable(status);
        const currencyAvailable = currencyStatus === VERIFIED_CURRENCY_STATUS;
        const eligibilityReasons: string[] = [];
        if (isExpired) eligibilityReasons.push('EXPIRED');
        if (!currencyAvailable) eligibilityReasons.push('CURRENCY_NOT_VERIFIED_USD');
        if (!statusAvailable && !isExpired) eligibilityReasons.push('STATUS_NOT_AVAILABLE');
        const eligible = eligibilityReasons.length === 0;
        const terms = supplierQuoteDraftTerms(quote.sourceDraft?.payloadJson, quote.sourceDraftItemKey);
        const coversRequiredQuantity = requiredQuantity === null ? null : quote.quantity >= requiredQuantity;
        const quantityShortfall = requiredQuantity === null ? null : Math.max(0, requiredQuantity - quote.quantity);
        const warnings: string[] = [];
        if (!quote.validUntil) warnings.push('VALID_UNTIL_UNKNOWN');
        if (coversRequiredQuantity === false) warnings.push('PARTIAL_QUANTITY');
        if (terms.conditionStatus === 'unknown') warnings.push('CONDITION_UNKNOWN');
        if (terms.certificateStatus === 'unknown') warnings.push('CERTIFICATE_UNKNOWN');
        if (terms.taxIncluded === null) warnings.push('TAX_BASIS_UNKNOWN');
        if (terms.freightIncluded === null) warnings.push('FREIGHT_BASIS_UNKNOWN');
        if (terms.incoterm === null) warnings.push('INCOTERM_UNKNOWN');
        if (scope.partScope?.certificateRequired === true && terms.certificateStatus === 'missing') {
          warnings.push('CERTIFICATE_REQUIRED_MISSING');
          if (terms.certificate === false) warnings.push('CERTIFICATE_REQUIREMENT_CONFLICT');
        } else if (scope.partScope?.certificateRequired === true && terms.certificateStatus === 'unknown') {
          warnings.push('CERTIFICATE_REQUIREMENT_UNKNOWN');
        }
        const certificateRequirementStatus = scope.partScope?.certificateRequired === false
          ? 'not_required'
          : scope.partScope?.certificateRequired === true
            ? terms.certificateStatus
            : 'unknown';
        const commercialBasis = supplierQuoteCommercialBasis(terms);
        return {
          quote,
          status,
          isExpired,
          currencyStatus,
          eligible,
          eligibilityReasons,
          terms,
          commercialBasis,
          coversRequiredQuantity,
          quantityShortfall,
          warnings,
          certificateRequirementStatus,
        };
      });
      const eligibleFacts = quoteFacts.filter((fact) => fact.eligible);
      const eligibleQuotes = eligibleFacts.map((fact) => fact.quote);
      const expiredQuoteCount = quoteFacts.filter((fact) => fact.isExpired).length;
      const unverifiedCurrencyQuoteCount = quoteFacts.filter((fact) => !fact.eligible && !fact.isExpired
        && fact.currencyStatus !== VERIFIED_CURRENCY_STATUS).length;
      const unavailableStatusQuoteCount = quoteFacts.filter((fact) => !fact.eligible
        && !fact.isExpired && fact.currencyStatus === VERIFIED_CURRENCY_STATUS).length;
      const excludedQuoteCount = groupQuotes.length - eligibleQuotes.length;
      const basisBuckets = new Map<string, typeof quoteFacts>();
      for (const fact of quoteFacts) {
        const bucket = basisBuckets.get(fact.commercialBasis.key) ?? [];
        bucket.push(fact);
        basisBuckets.set(fact.commercialBasis.key, bucket);
      }
      const commercialBasisGroups = [...basisBuckets.entries()].map(([key, basisFacts]) => {
        const basisEligibleFacts = basisFacts.filter((fact) => fact.eligible);
        const basisEligibleQuotes = basisEligibleFacts.map((fact) => fact.quote);
        const basisMissingPerformanceCount = basisEligibleQuotes.filter((quote) =>
          typeof quote.supplier.performanceScore !== 'number').length;
        const minPrice = basisEligibleQuotes.length > 0
          ? Math.min(...basisEligibleQuotes.map(supplierQuoteUnitPrice))
          : null;
        const maxPrice = basisEligibleQuotes.length > 0
          ? Math.max(...basisEligibleQuotes.map(supplierQuoteUnitPrice))
          : null;
        const avgPrice = basisEligibleQuotes.length > 0
          ? basisEligibleQuotes.reduce((sum, quote) => sum + supplierQuoteUnitPrice(quote), 0) / basisEligibleQuotes.length
          : null;
        const comparisonAvailable = basisEligibleQuotes.length >= 2 && basisMissingPerformanceCount === 0;
        const comparedQuotes = basisFacts.map((fact) => {
          const { quote, eligible, terms, commercialBasis } = fact;
          const unitPrice = supplierQuoteUnitPrice(quote);
          const totalPrice = supplierQuoteTotalPrice(quote);
          const priceScore = comparisonAvailable && eligible
            ? (maxPrice === minPrice ? 100 : ((maxPrice! - unitPrice) / (maxPrice! - minPrice!)) * 100)
            : null;
          const leadTimeScore = comparisonAvailable && eligible
            ? (quote.leadTimeDays <= 7 ? 100 : Math.max(0, 100 - (quote.leadTimeDays - 7) * 5))
            : null;
          const supplierPerformanceScore = comparisonAvailable && eligible
            ? Math.min(100, Math.max(0, quote.supplier.performanceScore!))
            : null;
          const ruleScore = comparisonAvailable && eligible
            ? Math.round((priceScore! * 0.5 + leadTimeScore! * 0.3 + supplierPerformanceScore! * 0.2) * 10) / 10
            : null;
          const priceDiff = eligible && minPrice !== null && minPrice > 0
            ? Math.round(((unitPrice - minPrice) / minPrice) * 1000) / 10
            : null;

          return {
            id: quote.id,
            rfqId: quote.rfqId,
            rfqLineId: quote.rfqLineId,
            inquiryId: quote.inquiryId,
            inquiryItemId: quote.inquiryItemId,
            partNumber: quote.partNumber,
            quantity: quote.quantity,
            requiredQuantity,
            coversRequiredQuantity: fact.coversRequiredQuantity,
            quantityShortfall: fact.quantityShortfall,
            validUntil: quote.validUntil?.toISOString() ?? null,
            isExpired: fact.isExpired,
            comparisonEligibility: {
              eligible,
              reasons: fact.eligibilityReasons,
              warnings: fact.warnings,
            },
            eligibleForComparison: eligible,
            eligibilityReasons: fact.eligibilityReasons,
            commercialTerms: commercialBasis.terms,
            commercialBasisKey: commercialBasis.key,
            commercialBasisLabel: commercialBasis.label,
            condition: terms.condition,
            conditionStatus: terms.conditionStatus,
            certificate: terms.certificate,
            certificateStatus: terms.certificateStatus,
            certificateRequired: scope.partScope?.certificateRequired ?? null,
            certificateRequirementStatus: fact.certificateRequirementStatus,
            warnings: fact.warnings,
            supplier: {
              id: quote.supplier.id,
              name: quote.supplier.name,
              level: quote.supplier.level,
              performanceScore: quote.supplier.performanceScore,
            },
            unitPrice,
            totalPrice,
            currency: quote.currency || null,
            currencyStatus: fact.currencyStatus,
            leadTimeDays: quote.leadTimeDays,
            priceDiff,
            isLowestPrice: eligible && minPrice !== null && unitPrice === minPrice,
            scoreComponents: {
              price: priceScore === null ? null : Math.round(priceScore),
              leadTime: leadTimeScore === null ? null : Math.round(leadTimeScore),
              supplierPerformance: supplierPerformanceScore === null ? null : Math.round(supplierPerformanceScore),
            },
            ruleScore,
            status: fact.status,
            isWinner: quote.isWinner,
          };
        });

        comparedQuotes.sort((left, right) => {
          const leftEligible = left.eligibleForComparison ? 1 : 0;
          const rightEligible = right.eligibleForComparison ? 1 : 0;
          if (leftEligible !== rightEligible) return rightEligible - leftEligible;
          return comparisonAvailable ? (right.ruleScore ?? 0) - (left.ruleScore ?? 0) : 0;
        });
        const basisExpiredQuoteCount = basisFacts.filter((fact) => fact.isExpired).length;
        const basisExcludedQuoteCount = basisFacts.length - basisEligibleQuotes.length;
        const basisUnverifiedCurrencyQuoteCount = basisFacts.filter((fact) => !fact.eligible && !fact.isExpired
          && fact.currencyStatus !== VERIFIED_CURRENCY_STATUS).length;
        const basisUnavailableStatusQuoteCount = basisFacts.filter((fact) => !fact.eligible
          && !fact.isExpired && fact.currencyStatus === VERIFIED_CURRENCY_STATUS).length;
        const exclusionDetails = [
          basisExpiredQuoteCount > 0 ? `${basisExpiredQuoteCount} 份已过期` : null,
          basisUnverifiedCurrencyQuoteCount > 0 ? `${basisUnverifiedCurrencyQuoteCount} 份币种未核为 USD` : null,
          basisUnavailableStatusQuoteCount > 0 ? `${basisUnavailableStatusQuoteCount} 份状态不可用` : null,
        ].filter((value): value is string => value !== null).join('、');
        const reason = comparisonAvailable
          ? `仅对同一商务口径下的 ${basisEligibleQuotes.length} 份有效 USD 报价排序；排除 ${basisExcludedQuoteCount} 份${exclusionDetails ? `（${exclusionDetails}）` : ''}。`
          : basisEligibleQuotes.length < 2
            ? `该商务口径仅有 ${basisEligibleQuotes.length} 份可比报价，无法进行相对规则排序；排除 ${basisExcludedQuoteCount} 份${exclusionDetails ? `（${exclusionDetails}）` : ''}。`
            : `${basisMissingPerformanceCount} 家可比报价供应商缺少绩效记录，无法生成完整规则排序；排除 ${basisExcludedQuoteCount} 份${exclusionDetails ? `（${exclusionDetails}）` : ''}。`;
        const bestAvailableQuantity = basisEligibleQuotes.length > 0
          ? Math.max(...basisEligibleQuotes.map((quote) => quote.quantity))
          : 0;
        return {
          key,
          label: basisFacts[0].commercialBasis.label,
          terms: basisFacts[0].commercialBasis.terms,
          quotes: comparedQuotes,
          topRanked: comparisonAvailable ? comparedQuotes.find((quote) => quote.eligibleForComparison) ?? null : null,
          summary: {
            totalQuotes: basisFacts.length,
            comparableQuoteCount: basisEligibleQuotes.length,
            expiredQuoteCount: basisExpiredQuoteCount,
            requiredQuantity,
            bestAvailableQuantity,
            remainingQuantityGap: requiredQuantity === null ? null : Math.max(0, requiredQuantity - bestAvailableQuantity),
            lowestPrice: minPrice,
            highestPrice: maxPrice,
            averagePrice: avgPrice === null ? null : Math.round(avgPrice * 100) / 100,
          },
          metadata: {
            ...baseMetadata,
            status: comparisonAvailable ? 'available' : 'insufficient_data',
            sampleSize: basisEligibleQuotes.length,
            totalQuoteCount: basisFacts.length,
            excludedQuoteCount: basisExcludedQuoteCount,
            expiredQuoteCount: basisExpiredQuoteCount,
            exclusionCounts: {
              expired: basisExpiredQuoteCount,
              unverifiedCurrency: basisUnverifiedCurrencyQuoteCount,
              unavailableStatus: basisUnavailableStatusQuoteCount,
            },
            reason,
          },
        };
      });
      const eligibleBasisGroups = commercialBasisGroups.filter((group) => group.summary.comparableQuoteCount > 0);
      const onlyEligibleBasisGroup = eligibleBasisGroups.length === 1 ? eligibleBasisGroups[0] : null;
      const missingPerformanceCount = eligibleQuotes.filter((quote) => typeof quote.supplier.performanceScore !== 'number').length;
      const partMinPrice = onlyEligibleBasisGroup?.summary.lowestPrice ?? null;
      const partMaxPrice = onlyEligibleBasisGroup?.summary.highestPrice ?? null;
      const partAvgPrice = onlyEligibleBasisGroup?.summary.averagePrice ?? null;
      const comparisonAvailable = onlyEligibleBasisGroup?.metadata.status === 'available';
      const partReason = eligibleBasisGroups.length > 1
        ? `该件号存在 ${eligibleBasisGroups.length} 个不同商务口径组，不能合并价格区间或生成跨口径排序；各口径分别比较。`
        : onlyEligibleBasisGroup
          ? onlyEligibleBasisGroup.metadata.reason
          : eligibleQuotes.length === 0
            ? `该件号没有可参与比较的有效 USD 报价；排除 ${excludedQuoteCount} 份。`
            : `${missingPerformanceCount} 家可比报价供应商缺少绩效记录，无法生成完整规则排序。`;
      const bestAvailableQuantity = eligibleQuotes.length > 0
        ? Math.max(...eligibleQuotes.map((quote) => quote.quantity))
        : 0;
      const comparedQuotes = commercialBasisGroups.flatMap((group) => group.quotes);
      return {
        partNumber,
        quotes: comparedQuotes,
        commercialBasisGroups,
        topRanked: onlyEligibleBasisGroup?.topRanked ?? null,
        summary: {
          totalQuotes: groupQuotes.length,
          comparableQuoteCount: eligibleQuotes.length,
          expiredQuoteCount,
          requiredQuantity,
          bestAvailableQuantity,
          remainingQuantityGap: requiredQuantity === null ? null : Math.max(0, requiredQuantity - bestAvailableQuantity),
          lowestPrice: partMinPrice,
          highestPrice: partMaxPrice,
          averagePrice: partAvgPrice,
        },
        metadata: {
          ...baseMetadata,
          status: comparisonAvailable ? 'available' : 'insufficient_data',
          sampleSize: eligibleQuotes.length,
          totalQuoteCount: groupQuotes.length,
          excludedQuoteCount,
          expiredQuoteCount,
          eligibleCommercialBasisGroupCount: eligibleBasisGroups.length,
          differentCommercialBasisGroups: eligibleBasisGroups.length > 1,
          missingPerformanceCount,
          exclusionCounts: {
            expired: expiredQuoteCount,
            unverifiedCurrency: unverifiedCurrencyQuoteCount,
            unavailableStatus: unavailableStatusQuoteCount,
          },
          reason: partReason,
        },
      };
    });

    const onlyGroup = partNumberGroups.length === 1 ? partNumberGroups[0] : null;
    const allComparedQuotes = partNumberGroups.flatMap((group) => group.quotes);
    const totalComparableQuoteCount = partNumberGroups.reduce((sum, group) => sum + group.summary.comparableQuoteCount, 0);
    const totalExpiredQuoteCount = partNumberGroups.reduce((sum, group) => sum + group.summary.expiredQuoteCount, 0);
    const totalExcludedQuoteCount = quotes.length - totalComparableQuoteCount;
    const combinedMetadata = onlyGroup?.metadata ?? {
      ...baseMetadata,
      status: 'insufficient_data',
      sampleSize: totalComparableQuoteCount,
      totalQuoteCount: quotes.length,
      excludedQuoteCount: totalExcludedQuoteCount,
      expiredQuoteCount: totalExpiredQuoteCount,
      reason: `该需求行包含多个实际件号；各件号已分组比较，不能跨件号合并价格区间或给出全局中选排序。共排除 ${totalExcludedQuoteCount} 份报价，其中 ${totalExpiredQuoteCount} 份已过期。`,
    };

    res.json({
      success: true,
      data: {
        rfqId: scope.rfqId,
        rfqLineId: scope.rfqLineId,
        inquiryId: scope.inquiryId,
        inquiryItemId: scope.inquiryItemId,
        quotes: allComparedQuotes,
        partNumberGroups,
        topRanked: onlyGroup?.topRanked ?? null,
        summary: onlyGroup?.summary ?? {
          totalQuotes: quotes.length,
          comparableQuoteCount: totalComparableQuoteCount,
          expiredQuoteCount: totalExpiredQuoteCount,
          requiredQuantity,
          bestAvailableQuantity: null,
          remainingQuantityGap: null,
          lowestPrice: null,
          highestPrice: null,
          averagePrice: null,
        },
        metadata: combinedMetadata,
      },
    });
  })
);

router.post(
  '/:id/select-winner',
  requireCapability('supplier_quote', 'update'),
  asyncHandler(async (req, res) => {
    const quoteId = req.params.id;
    const updated = await prisma.$transaction(async (tx) => {
      const quote = await tx.supplierQuote.findUnique({ where: { id: quoteId } });
      if (!quote) throw new AppError('供应商报价不存在', 404, 'RESOURCE_NOT_FOUND');
      if (supplierQuoteCurrencyStatus(quote.currency, quote.currencyReviewStatus) !== VERIFIED_CURRENCY_STATUS) {
        throw new AppError('历史供应商报价币种待核，确认 USD 后才能标记中选', 409, 'STATE_CONFLICT');
      }
      if (!supplierQuoteComparisonStatusIsAvailable(supplierQuoteStatus(quote))) {
        throw new AppError('供应商报价状态不可用，不能标记中选', 409, 'STATE_CONFLICT');
      }
      if (quote.validUntil && quote.validUntil.getTime() <= Date.now()) {
        throw new AppError('供应商报价已过期，不能标记中选', 409, 'STATE_CONFLICT');
      }

      const clearScope = await resolveWinnerClearScope(tx, quote);
      // The line-scoped clear and winner update share a serializable transaction.
      // Concurrent selections for one line therefore serialize or one fails with P2034.
      await tx.supplierQuote.updateMany({ where: clearScope, data: { isWinner: false } });
      return tx.supplierQuote.update({
        where: { id: quoteId },
        data: {
          isWinner: true,
          status: 'accepted',
          statusEnum: toSupplierQuoteStatusEnum('accepted')!,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    res.json({
      success: true,
      message: '供应商已标记为中选',
      data: projectSupplierQuoteMoney(updated),
    });
  })
);

export default router;
