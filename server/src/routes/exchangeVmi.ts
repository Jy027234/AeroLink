import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';

const router = Router();

function getRecentMonthLabels(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setMonth(date.getMonth() - (count - index - 1), 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
}

async function getCurrentStock(partNumber: string) {
  const inventory = await prisma.inventory.findMany({
    where: { partNumber },
    select: { quantity: true, unitCost: true },
  });

  return {
    stock: inventory.reduce((sum, item) => sum + (item.quantity || 0), 0),
    value: inventory.reduce((sum, item) => sum + (item.quantity || 0) * (item.unitCost || 0), 0),
  };
}

router.get(
  '/exchanges',
  asyncHandler(async (_req, res) => {
    const orders = await prisma.order.findMany({
      where: {
        saleType: { equals: 'Exchange', mode: 'insensitive' },
      },
      include: {
        quotation: { select: { quoteNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    res.json({
      success: true,
      data: orders.map((order) => ({
        id: order.id,
        quoteId: order.quotation.quoteNumber || order.orderNumber,
        coreCharge: order.exchangeCoreCharge || Math.round(order.totalAmount * 0.2),
        coreReturned: order.outboundStatus === 'COMPLETED' && (order.status === 'DELIVERED' || order.status === 'COMPLETED'),
        returnDeadline: 30,
        coreEvaluationCriteria: '铭牌完整、无结构性损伤、可追溯文件齐全',
        acceptableDamageRange: '允许轻微外观磨损，不接受结构裂纹和腐蚀超限',
      })),
    });
  })
);

router.get(
  '/vmi-agreements',
  asyncHandler(async (_req, res) => {
    const agreements = await prisma.vMIAgreement.findMany({
      include: {
        customer: { select: { name: true } },
      },
      orderBy: { customerId: 'asc' },
    });

    const data = await Promise.all(
      agreements.map(async (agreement) => {
        const labels = getRecentMonthLabels(3);
        const consumptionData = await Promise.all(
          labels.map(async (label) => {
            const start = new Date(`${label}-01T00:00:00.000Z`);
            const end = new Date(start);
            end.setMonth(end.getMonth() + 1);

            const orders = await prisma.order.findMany({
              where: {
                customerId: agreement.customerId,
                partNumber: agreement.partNumber,
                createdAt: { gte: start, lt: end },
              },
              select: { quantity: true },
            });

            return {
              month: label,
              quantity: orders.reduce((sum, order) => sum + order.quantity, 0),
            };
          })
        );

        return {
          id: agreement.id,
          customerName: agreement.customer.name,
          partNumber: agreement.partNumber,
          minStock: agreement.minStock,
          maxStock: agreement.maxStock,
          reorderPoint: agreement.reorderPoint,
          reorderQty: agreement.reorderQty,
          consumptionData,
        };
      })
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.get(
  '/restock-suggestions',
  asyncHandler(async (_req, res) => {
    const agreements = await prisma.vMIAgreement.findMany({
      include: {
        customer: { select: { name: true } },
      },
    });

    const suggestions = await Promise.all(
      agreements.map(async (agreement) => {
        const { stock } = await getCurrentStock(agreement.partNumber);
        if (stock > agreement.reorderPoint) {
          return null;
        }

        return {
          id: agreement.id,
          partNumber: agreement.partNumber,
          customerName: agreement.customer.name,
          currentStock: stock,
          suggestedQty: Math.max(agreement.reorderQty, agreement.maxStock - stock),
          reason: `当前库存低于补货点 ${agreement.reorderPoint} EA`,
          expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };
      })
    );

    res.json({
      success: true,
      data: suggestions.filter(Boolean),
    });
  })
);

router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [exchangeOrders, agreements] = await Promise.all([
      prisma.order.findMany({
        where: { saleType: { equals: 'Exchange', mode: 'insensitive' } },
        select: {
          totalAmount: true,
          exchangeCoreCharge: true,
          status: true,
          createdAt: true,
          customerId: true,
          partNumber: true,
        },
      }),
      prisma.vMIAgreement.findMany(),
    ]);

    const restockSuggestions = await Promise.all(
      agreements.map(async (agreement) => {
        const { stock } = await getCurrentStock(agreement.partNumber);
        return stock <= agreement.reorderPoint;
      })
    );

    const uniqueCustomers = new Set(agreements.map((agreement) => agreement.customerId));
    const inventoryValues = await Promise.all(agreements.map((agreement) => getCurrentStock(agreement.partNumber)));
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    res.json({
      success: true,
      data: {
        activeExchanges: exchangeOrders.filter((order) => order.status !== 'COMPLETED').length,
        pendingCoreReturns: exchangeOrders.filter((order) => order.status !== 'DELIVERED' && order.status !== 'COMPLETED').length,
        totalCoreDeposit: exchangeOrders.reduce(
          (sum, order) => sum + (order.exchangeCoreCharge || Math.round(order.totalAmount * 0.2)),
          0
        ),
        monthlySettlement: exchangeOrders
          .filter((order) => order.createdAt >= monthStart && (order.status === 'DELIVERED' || order.status === 'COMPLETED'))
          .reduce((sum, order) => sum + (order.exchangeCoreCharge || Math.round(order.totalAmount * 0.2)), 0),
        vmiCustomers: uniqueCustomers.size,
        vmiPartNumbers: agreements.length,
        pendingRestock: restockSuggestions.filter(Boolean).length,
        totalVmiInventoryValue: inventoryValues.reduce((sum, item) => sum + item.value, 0),
      },
    });
  })
);

export default router;
