import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { customerCreateSchema, customerUpdateSchema } from '../lib/validation.js';
import prisma from '../lib/prisma.js';

const router = Router();

const customerInclude = {
  decisionMakers: true,
  contacts: true,
  competitorListings: true,
};

function serializeCustomer(c: any) {
  return {
    id: c.id,
    name: c.name,
    buyerType: c.buyerType,
    businessDescription: c.businessDescription,
    contactName: c.contactName,
    email: c.email,
    phone: c.phone,
    registeredAddress: c.registeredAddress,
    shipToAddress: c.shipToAddress,
    shipForAddress: c.shipForAddress,
    shippingContactName: c.shippingContactName,
    shippingContactPhone: c.shippingContactPhone,
    creditLimit: c.creditLimit,
    creditRating: c.creditRating,
    paymentTerms: c.paymentTerms,
    paymentMethod: c.paymentMethod,
    annualRevenue: c.annualRevenue,
    vatNumber: c.vatNumber,
    iataCode: c.iataCode,
    icaoCode: c.icaoCode,
    aocNumber: c.aocNumber,
    preferredIncoterm: c.preferredIncoterm,
    customsBroker: c.customsBroker,
    qualityApprovalStatus: c.qualityApprovalStatus,
    status: c.status.toLowerCase(),
    lastOrderDate: c.lastOrderAt?.toISOString(),
    createdAt: c.createdAt?.toISOString(),
    updatedAt: c.updatedAt?.toISOString(),
    decisionMakers: c.decisionMakers?.map((dm: any) => ({
      id: dm.id,
      name: dm.name,
      title: dm.title,
      role: dm.role.toLowerCase(),
      concerns: dm.concerns?.split(',').filter(Boolean) || [],
      vetoItems: dm.vetoItems?.split(',').filter(Boolean) || [],
    })) || [],
    contacts: c.contacts?.map((ct: any) => ({
      id: ct.id,
      customerId: ct.customerId,
      name: ct.name,
      email: ct.email,
      phone: ct.phone,
      role: ct.role.toLowerCase(),
      isDefault: ct.isDefault,
      receiveRFQ: ct.receiveRFQ,
      receivePO: ct.receivePO,
    })) || [],
    competitorListings: c.competitorListings?.map((cl: any) => ({
      id: cl.id,
      customerId: cl.customerId,
      competitorName: cl.competitorName,
      advantageParts: cl.advantageParts,
      priceLevel: cl.priceLevel,
      notes: cl.notes,
    })) || [],
  };
}

router.get(
  '/',
  requireCapability('customer', 'read'),
  asyncHandler(async (req, res) => {
    const { status, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.CustomerWhereInput = {};
    if (status) where.status = status.toString().toUpperCase();
    const searchValue = typeof search === 'string' ? search.trim() : '';
    if (searchValue) {
      where.OR = [
        { name: { contains: searchValue, mode: 'insensitive' } },
        { contactName: { contains: searchValue, mode: 'insensitive' } },
        { email: { contains: searchValue, mode: 'insensitive' } },
      ];
    }

    const [customers, total, statusCounts, revenueAggregate] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: customerInclude,
        orderBy: { name: 'asc' },
        skip,
        take: pageSize,
      }),
      prisma.customer.count({ where }),
      prisma.customer.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.customer.aggregate({
        _sum: { annualRevenue: true },
      }),
    ]);

    const summaryCount = (statusValue: string) =>
      statusCounts.find((entry) => entry.status === statusValue)?._count._all || 0;
    const summary = {
      total: statusCounts.reduce((sum, entry) => sum + entry._count._all, 0),
      active: summaryCount('ACTIVE'),
      atRisk: summaryCount('AT_RISK'),
      inactive: summaryCount('INACTIVE'),
      totalRevenue: revenueAggregate._sum.annualRevenue || 0,
    };

    res.json({
      success: true,
      data: customers.map(serializeCustomer),
      summary,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  })
);

router.get(
  '/:id',
  requireCapability('customer', 'read'),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        ...customerInclude,
        rfqs: { take: 5, orderBy: { createdAt: 'desc' } },
        quotations: { take: 5, orderBy: { createdAt: 'desc' } },
      },
    });

    if (!customer) {
      throw new AppError('客户不存在', 404);
    }

    res.json({
      success: true,
      data: serializeCustomer(customer),
    });
  })
);

router.post(
  '/',
  requireCapability('customer', 'create'),
  validateBody(customerCreateSchema),
  asyncHandler(async (req, res) => {
    const {
      name,
      contactName,
      email,
      phone,
      buyerType,
      businessDescription,
      registeredAddress,
      shipToAddress,
      shipForAddress,
      shippingContactName,
      shippingContactPhone,
      creditLimit,
      creditRating,
      paymentTerms,
      paymentMethod,
      annualRevenue,
      vatNumber,
      iataCode,
      icaoCode,
      aocNumber,
      preferredIncoterm,
      customsBroker,
      qualityApprovalStatus,
      contacts,
      competitorListings,
    } = req.body;

    const customer = await prisma.customer.create({
      data: {
        name,
        contactName,
        email,
        phone,
        buyerType: buyerType || 'End User',
        businessDescription,
        registeredAddress,
        shipToAddress,
        shipForAddress,
        shippingContactName,
        shippingContactPhone,
        creditLimit,
        creditRating,
        paymentTerms,
        paymentMethod,
        annualRevenue,
        vatNumber,
        iataCode,
        icaoCode,
        aocNumber,
        preferredIncoterm,
        customsBroker,
        qualityApprovalStatus: qualityApprovalStatus || 'Pending',
        status: 'ACTIVE',
        contacts: contacts?.length
          ? {
              create: contacts.map((c: any) => ({
                name: c.name,
                email: c.email,
                phone: c.phone,
                role: c.role.toUpperCase(),
                isDefault: c.isDefault ?? false,
                receiveRFQ: c.receiveRFQ ?? false,
                receivePO: c.receivePO ?? false,
              })),
            }
          : undefined,
        competitorListings: competitorListings?.length
          ? {
              create: competitorListings.map((cl: any) => ({
                competitorName: cl.competitorName,
                advantageParts: cl.advantageParts,
                priceLevel: cl.priceLevel,
                notes: cl.notes,
              })),
            }
          : undefined,
      },
      include: customerInclude,
    });

    res.status(201).json({
      success: true,
      data: serializeCustomer(customer),
    });
  })
);

router.patch(
  '/:id',
  requireCapability('customer', 'update'),
  validateBody(customerUpdateSchema),
  asyncHandler(async (req, res) => {
    const {
      name,
      contactName,
      email,
      phone,
      buyerType,
      businessDescription,
      registeredAddress,
      shipToAddress,
      shipForAddress,
      shippingContactName,
      shippingContactPhone,
      creditLimit,
      creditRating,
      paymentTerms,
      paymentMethod,
      annualRevenue,
      vatNumber,
      iataCode,
      icaoCode,
      aocNumber,
      preferredIncoterm,
      customsBroker,
      qualityApprovalStatus,
      status,
      contacts,
      competitorListings,
    } = req.body;

    const existing = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: customerInclude,
    });

    if (!existing) {
      throw new AppError('客户不存在', 404);
    }

    // Handle nested contacts: delete existing and recreate if provided
    if (contacts !== undefined) {
      await prisma.customerContact.deleteMany({
        where: { customerId: req.params.id },
      });
    }

    // Handle nested competitorListings: delete existing and recreate if provided
    if (competitorListings !== undefined) {
      await prisma.competitorListing.deleteMany({
        where: { customerId: req.params.id },
      });
    }

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(contactName !== undefined && { contactName }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
        ...(buyerType !== undefined && { buyerType }),
        ...(businessDescription !== undefined && { businessDescription }),
        ...(registeredAddress !== undefined && { registeredAddress }),
        ...(shipToAddress !== undefined && { shipToAddress }),
        ...(shipForAddress !== undefined && { shipForAddress }),
        ...(shippingContactName !== undefined && { shippingContactName }),
        ...(shippingContactPhone !== undefined && { shippingContactPhone }),
        ...(creditLimit !== undefined && { creditLimit }),
        ...(creditRating !== undefined && { creditRating }),
        ...(paymentTerms !== undefined && { paymentTerms }),
        ...(paymentMethod !== undefined && { paymentMethod }),
        ...(annualRevenue !== undefined && { annualRevenue }),
        ...(vatNumber !== undefined && { vatNumber }),
        ...(iataCode !== undefined && { iataCode }),
        ...(icaoCode !== undefined && { icaoCode }),
        ...(aocNumber !== undefined && { aocNumber }),
        ...(preferredIncoterm !== undefined && { preferredIncoterm }),
        ...(customsBroker !== undefined && { customsBroker }),
        ...(qualityApprovalStatus !== undefined && { qualityApprovalStatus }),
        ...(status !== undefined && { status: status.toUpperCase().replace('-', '_') }),
        ...(contacts?.length && {
          contacts: {
            create: contacts.map((c: any) => ({
              name: c.name,
              email: c.email,
              phone: c.phone,
              role: c.role.toUpperCase(),
              isDefault: c.isDefault ?? false,
              receiveRFQ: c.receiveRFQ ?? false,
              receivePO: c.receivePO ?? false,
            })),
          },
        }),
        ...(competitorListings?.length && {
          competitorListings: {
            create: competitorListings.map((cl: any) => ({
              competitorName: cl.competitorName,
              advantageParts: cl.advantageParts,
              priceLevel: cl.priceLevel,
              notes: cl.notes,
            })),
          },
        }),
      },
      include: customerInclude,
    });

    res.json({
      success: true,
      data: serializeCustomer(customer),
    });
  })
);

router.delete(
  '/:id',
  requireCapability('customer', 'delete'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('客户不存在', 404);
    }

    await prisma.customer.update({
      where: { id: req.params.id },
      data: { status: 'INACTIVE' },
    });

    res.json({ success: true, message: '客户已停用' });
  })
);

export default router;
