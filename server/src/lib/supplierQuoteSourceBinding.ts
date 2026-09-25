import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import { assertQuotationMatchesRfq } from './commercialCostSource.js';

export type SupplierQuoteSourceBindingInput = {
  rfqId?: string | null;
  rfqLineId?: string | null;
  inquiryId?: string | null;
  inquiryItemId?: string | null;
  supplierId: string;
  partNumber: string;
  quantity: number;
};

export type SupplierQuoteSourceBinding = {
  rfqId: string | null;
  rfqLineId: string | null;
  inquiryId: string | null;
  inquiryItemId: string | null;
};

const supplierQuoteLineSelect = {
  id: true,
  rfqId: true,
  partNumber: true,
  quantity: true,
  alternatePartNumbers: true,
} satisfies Prisma.RfqLineSelect;

const supplierQuoteRfqSelect = {
  id: true,
  partNumber: true,
  quantity: true,
  alternatePartNumbers: true,
} satisfies Prisma.RFQSelect;

/**
 * Resolve supplier quote provenance by immutable IDs inside the create
 * transaction. A legacy RFQ with no lines remains unbound; a multi-line RFQ
 * must carry an explicit line ID so later quotation-line reconciliation cannot
 * silently attach a quote by part-number text alone.
 */
export async function resolveSupplierQuoteSourceBinding(
  tx: Prisma.TransactionClient,
  input: SupplierQuoteSourceBindingInput,
): Promise<SupplierQuoteSourceBinding> {
  let rfqId = input.rfqId || null;
  let rfqLineId = input.rfqLineId || null;
  let inquiryId = input.inquiryId || null;
  let inquiryItemId = input.inquiryItemId || null;

  let rfq = rfqId
    ? await tx.rFQ.findUnique({ where: { id: rfqId }, select: supplierQuoteRfqSelect })
    : null;
  if (rfqId && !rfq) {
    throw new AppError('关联 RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  let inquiry = inquiryId
    ? await tx.inquiry.findUnique({
      where: { id: inquiryId },
      select: { id: true, rfqId: true, supplierId: true },
    })
    : null;
  if (inquiryId && !inquiry) {
    throw new AppError('关联询价单不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (inquiry && inquiry.supplierId !== input.supplierId) {
    throw new AppError('供应商报价的供应商与询价单不一致', 409, 'RESOURCE_CONFLICT');
  }
  if (inquiry?.rfqId) {
    if (rfqId && rfqId !== inquiry.rfqId) {
      throw new AppError('询价单与 RFQ 不一致', 409, 'RESOURCE_CONFLICT');
    }
    rfqId = inquiry.rfqId;
    if (!rfq) {
      rfq = await tx.rFQ.findUnique({ where: { id: rfqId }, select: supplierQuoteRfqSelect });
    }
    if (!rfq) {
      throw new AppError('询价单关联的 RFQ 不存在', 409, 'RESOURCE_CONFLICT');
    }
  }

  let rfqLine = rfqLineId
    ? await tx.rfqLine.findUnique({ where: { id: rfqLineId }, select: supplierQuoteLineSelect })
    : null;
  if (rfqLineId && !rfqLine) {
    throw new AppError('指定的 RFQ 需求行不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (rfqLine) {
    if (rfqId && rfqLine.rfqId !== rfqId) {
      throw new AppError('RFQ 需求行不属于当前 RFQ', 409, 'INVALID_RFQ_LINE');
    }
    if (!rfqId) {
      rfqId = rfqLine.rfqId;
      rfq = await tx.rFQ.findUnique({ where: { id: rfqId }, select: supplierQuoteRfqSelect });
      if (!rfq) {
        throw new AppError('RFQ 需求行关联的 RFQ 不存在', 409, 'RESOURCE_CONFLICT');
      }
    }
    assertQuotationMatchesRfq(input.partNumber, input.quantity, rfqLine);
  } else if (rfq) {
    const lines = await tx.rfqLine.findMany({
      where: { rfqId: rfq.id },
      select: supplierQuoteLineSelect,
      orderBy: { lineNo: 'asc' },
    });
    if (lines.length > 1) {
      throw new AppError('多行 RFQ 必须明确指定 rfqLineId，不能按件号猜测', 409, 'LINE_ID_REQUIRED');
    }
    if (lines.length === 1) {
      [rfqLine] = lines;
      rfqLineId = rfqLine.id;
      assertQuotationMatchesRfq(input.partNumber, input.quantity, rfqLine);
    } else {
      // Legacy RFQs have no immutable line identity. Keep the quote readable
      // for migration/review, but do not invent a line binding.
      assertQuotationMatchesRfq(input.partNumber, input.quantity, rfq);
    }
  }

  if (rfq && !rfqLine && rfqId) {
    assertQuotationMatchesRfq(input.partNumber, input.quantity, rfq);
  }

  const inquiryItem = inquiryItemId
    ? await tx.inquiryItem.findUnique({
      where: { id: inquiryItemId },
      select: {
        id: true,
        inquiryId: true,
        rfqLineId: true,
        partNumber: true,
        quantity: true,
        inquiry: { select: { id: true, rfqId: true, supplierId: true } },
      },
    })
    : null;
  if (inquiryItemId && !inquiryItem) {
    throw new AppError('指定的询价需求项不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (inquiryItem) {
    if (inquiryId && inquiryItem.inquiryId !== inquiryId) {
      throw new AppError('询价需求项不属于当前询价单', 409, 'RESOURCE_CONFLICT');
    }
    if (!inquiryId) inquiryId = inquiryItem.inquiryId;
    inquiry = inquiry ?? inquiryItem.inquiry;
    if (inquiry.supplierId !== input.supplierId) {
      throw new AppError('供应商报价的供应商与询价需求项不一致', 409, 'RESOURCE_CONFLICT');
    }
    if (inquiry.rfqId) {
      if (rfqId && inquiry.rfqId !== rfqId) {
        throw new AppError('询价需求项与 RFQ 不一致', 409, 'RESOURCE_CONFLICT');
      }
      rfqId = inquiry.rfqId;
    }
    if (rfqLineId && inquiryItem.rfqLineId !== rfqLineId) {
      throw new AppError('询价需求项与 RFQ 需求行不一致', 409, 'INVALID_RFQ_LINE');
    }
    if (rfqLineId && inquiryItem.rfqLineId === rfqLineId) {
      if (input.quantity > inquiryItem.quantity) {
        throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
      }
    } else if (inquiryItem.rfqLineId) {
      rfqLineId = inquiryItem.rfqLineId;
      rfqLine = await tx.rfqLine.findUnique({ where: { id: rfqLineId }, select: supplierQuoteLineSelect });
      if (!rfqLine) {
        throw new AppError('询价需求项关联的 RFQ 需求行不存在', 409, 'RESOURCE_CONFLICT');
      }
      if (rfqId && rfqLine.rfqId !== rfqId) {
        throw new AppError('询价需求项与 RFQ 不一致', 409, 'INVALID_RFQ_LINE');
      }
      if (!rfqId) rfqId = rfqLine.rfqId;
      assertQuotationMatchesRfq(input.partNumber, input.quantity, rfqLine);
      if (input.quantity > inquiryItem.quantity) {
        throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
      }
    } else if (rfqLine) {
      throw new AppError('询价需求项缺少 RFQ 需求行，不能安全绑定', 409, 'LINE_ID_REQUIRED');
    }
  }

  if (inquiry && rfqLineId && !inquiryItemId) {
    const matchingItems = await tx.inquiryItem.findMany({
      where: { inquiryId: inquiry.id, rfqLineId },
      select: {
        id: true,
        inquiryId: true,
        rfqLineId: true,
        partNumber: true,
        quantity: true,
      },
    });
    if (matchingItems.length !== 1) {
      throw new AppError('指定询价单无法唯一匹配 RFQ 需求项', 409, 'LINE_ID_REQUIRED');
    }
    const matchedItem = matchingItems[0];
    inquiryItemId = matchedItem.id;
    if (input.quantity > matchedItem.quantity) {
      throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
    }
  }

  return { rfqId, rfqLineId, inquiryId, inquiryItemId };
}
