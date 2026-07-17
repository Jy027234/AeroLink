import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';

const router = Router();

function generateInquiryNumber(): string {
  return `INQ-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
}

function serializeInquiry(inquiry: {
  id: string;
  inquiryNumber: string;
  supplierId: string;
  isAOG: boolean;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  supplier: { name: string };
  items: Array<{
    partNumber: string;
    quantity: number;
    requiredDate: Date;
    certificateRequired: boolean;
  }>;
}) {
  return {
    id: inquiry.id,
    inquiryNumber: inquiry.inquiryNumber,
    supplierId: inquiry.supplierId,
    supplierName: inquiry.supplier.name,
    items: inquiry.items.map((item) => ({
      partNumber: item.partNumber,
      quantity: item.quantity,
      requiredDate: item.requiredDate.toISOString(),
      certificateRequired: item.certificateRequired,
    })),
    isAOG: inquiry.isAOG,
    status: inquiry.status.toLowerCase(),
    createdAt: inquiry.createdAt.toISOString(),
    sentAt: inquiry.sentAt?.toISOString(),
  };
}

router.get(
  '/',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (_req, res) => {
    const inquiries = await prisma.inquiry.findMany({
      include: {
        supplier: { select: { name: true } },
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: inquiries.map(serializeInquiry),
    });
  })
);

router.get(
  '/:id',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const inquiry = await prisma.inquiry.findUnique({
      where: { id: req.params.id },
      include: {
        supplier: { select: { name: true } },
        items: true,
      },
    });

    if (!inquiry) {
      throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: serializeInquiry(inquiry),
    });
  })
);

router.post(
  '/',
  requireCapability('supplier_quote', 'create'),
  asyncHandler(async (req, res) => {
    const { rfqId, supplierIds, isAOG } = req.body as {
      rfqId?: string;
      supplierIds?: string[];
      isAOG?: boolean;
    };

    if (!rfqId || !Array.isArray(supplierIds) || supplierIds.length === 0) {
      throw new AppError('询价参数不完整', 400, 'VALIDATION_ERROR');
    }

    const rfq = await prisma.rFQ.findUnique({
      where: { id: rfqId },
    });

    if (!rfq) {
      throw new AppError('RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const uniqueSupplierIds = Array.from(new Set(supplierIds));
    const suppliers = await prisma.supplier.findMany({
      where: { id: { in: uniqueSupplierIds } },
      select: { id: true },
    });

    if (suppliers.length !== uniqueSupplierIds.length) {
      throw new AppError('存在无效供应商', 400, 'VALIDATION_ERROR');
    }

    const inquiries = await prisma.$transaction(
      uniqueSupplierIds.map((supplierId) =>
        prisma.inquiry.create({
          data: {
            inquiryNumber: generateInquiryNumber(),
            supplierId,
            isAOG: isAOG ?? rfq.urgency === 'AOG',
            status: 'DRAFT',
            items: {
              create: [
                {
                  partNumber: rfq.partNumber,
                  quantity: rfq.quantity,
                  requiredDate: rfq.requiredDate,
                  certificateRequired: rfq.certificateRequired,
                },
              ],
            },
          },
          include: {
            supplier: { select: { name: true } },
            items: true,
          },
        })
      )
    );

    res.status(201).json({
      success: true,
      data: inquiries.map(serializeInquiry),
    });
  })
);

router.post(
  '/:id/send',
  requireCapability('supplier_quote', 'create'),
  asyncHandler(async (req, res) => {
    const inquiry = await prisma.inquiry.findUnique({
      where: { id: req.params.id },
      include: {
        supplier: { select: { name: true } },
        items: true,
      },
    });

    if (!inquiry) {
      throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const updated = await prisma.inquiry.update({
      where: { id: req.params.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
      },
      include: {
        supplier: { select: { name: true } },
        items: true,
      },
    });

    res.json({
      success: true,
      data: serializeInquiry(updated),
    });
  })
);

export default router;
