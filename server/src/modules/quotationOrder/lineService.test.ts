import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assertLineCommercialAmounts } from './lineService.js';

function quotationWithLine(marginPercent = '40.0000') {
  const unitPrice = new Prisma.Decimal('10.0000');
  const costPrice = new Prisma.Decimal('6.0000');
  return {
    totalPrice: 20,
    totalPriceDecimal: new Prisma.Decimal('20.0000'),
    lines: [{
      rfqLineId: 'rfq-line-1',
      quantity: 2,
      unitPrice,
      costPrice,
      lineTotal: new Prisma.Decimal('20.0000'),
      marginAmount: new Prisma.Decimal('8.0000'),
      marginPercent: new Prisma.Decimal(marginPercent),
      currency: 'USD',
      acceptedQuantity: 0,
    }],
  } as never;
}

describe('line quotation commercial amount policy', () => {
  it('requires each line marginPercent to match the Decimal margin calculation', () => {
    expect(() => assertLineCommercialAmounts(quotationWithLine())).not.toThrow();
    expect(() => assertLineCommercialAmounts(quotationWithLine('41.0000'))).toThrowError(/报价行金额、币种或成交数量不一致/);
  });
});
