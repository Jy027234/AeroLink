import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { createAuditLog } from '../middleware/auditLogger.js';
import { validateBody } from '../middleware/validate.js';
import { customerCreateSchema, customerUpdateSchema } from '../lib/validation.js';
import { parseControlledExportWindow, parseListQuery, sendCsv, type SortDirection } from '../lib/listQuery.js';
import { customerRepository, normalizeCustomerStatus, updateCustomerAggregate } from '../modules/customerSupplier/index.js';

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

type CustomerListSort = 'name' | 'createdAt' | 'annualRevenue' | 'lastOrderAt';

function customerListOrderBy(
  sort: CustomerListSort,
  direction: SortDirection,
): Prisma.CustomerOrderByWithRelationInput[] {
  switch (sort) {
    case 'createdAt':
      return [{ createdAt: direction }, { id: 'asc' }];
    case 'annualRevenue':
      return [{ annualRevenue: direction }, { id: 'asc' }];
    case 'lastOrderAt':
      return [{ lastOrderAt: direction }, { id: 'asc' }];
    default:
      return [{ name: direction }, { id: 'asc' }];
  }
}

function buildCustomerListWhere(query: Record<string, unknown>): Prisma.CustomerWhereInput {
  const status = typeof query.status === 'string' ? query.status : '';
  const search = typeof query.search === 'string' ? query.search : '';
  const where: Prisma.CustomerWhereInput = {};
  if (status) where.status = status.toUpperCase();
  const searchValue = search.trim();
  if (searchValue) {
    where.OR = [
      { name: { contains: searchValue, mode: 'insensitive' } },
      { contactName: { contains: searchValue, mode: 'insensitive' } },
      { email: { contains: searchValue, mode: 'insensitive' } },
    ];
  }
  return where;
}

router.get(
  '/',
  requireCapability('customer', 'read'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const { page: pageNum, limit: pageSize, skip, sort, direction } = parseListQuery<CustomerListSort>(query, {
      allowedSorts: ['name', 'createdAt', 'annualRevenue', 'lastOrderAt'],
      defaultSort: 'name',
      defaultDirection: 'asc',
    });
    const where = buildCustomerListWhere(query);

    const [customers, total, statusCounts, revenueAggregate] = await Promise.all([
          customerRepository.findMany({
        where,
        include: customerInclude,
        orderBy: customerListOrderBy(sort, direction),
        skip,
        take: pageSize,
      }),
          customerRepository.count({ where }),
          customerRepository.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
          customerRepository.aggregate({
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
        sort,
        direction,
      },
    });
  })
);

router.get(
  '/export.csv',
  requireCapability('customer', 'export'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const window = parseControlledExportWindow(query);
    const { sort, direction } = parseListQuery<CustomerListSort>(query, {
      allowedSorts: ['name', 'createdAt', 'annualRevenue', 'lastOrderAt'],
      defaultSort: 'name',
      defaultDirection: 'asc',
    });
    const customers = await customerRepository.findMany({
      where: buildCustomerListWhere(query),
      select: {
        name: true,
        buyerType: true,
        contactName: true,
        email: true,
        phone: true,
        status: true,
        annualRevenue: true,
        lastOrderAt: true,
        createdAt: true,
      },
      orderBy: customerListOrderBy(sort, direction),
      skip: window.skip,
      take: window.take,
    });

    await createAuditLog({
      req,
      action: 'EXPORT',
      resourceType: 'CUSTOMER',
      details: `Customer CSV export (${window.scope}, ${customers.length}/${window.rowLimit} rows)`,
    });
    sendCsv(
      res,
      `customers-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { header: '客户名称', value: (customer) => customer.name },
        { header: '买方类型', value: (customer) => customer.buyerType },
        { header: '联系人', value: (customer) => customer.contactName },
        { header: '邮箱', value: (customer) => customer.email },
        { header: '电话', value: (customer) => customer.phone },
        { header: '状态', value: (customer) => customer.status },
        { header: '年营收', value: (customer) => customer.annualRevenue },
        { header: '最近订单日期', value: (customer) => customer.lastOrderAt },
        { header: '创建时间', value: (customer) => customer.createdAt },
      ],
      customers,
      window,
    );
  }),
);

router.get(
  '/:id',
  requireCapability('customer', 'read'),
  asyncHandler(async (req, res) => {
    const customer = await customerRepository.findUnique({
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

    const customer = await customerRepository.create({
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

    const customer = await updateCustomerAggregate(req.params.id, {
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
        ...(status !== undefined && { status: normalizeCustomerStatus(status) }),
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
      }, customerInclude, {
        contactsProvided: contacts !== undefined,
        competitorListingsProvided: competitorListings !== undefined,
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
    const existing = await customerRepository.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('客户不存在', 404);
    }

    await customerRepository.update({
      where: { id: req.params.id },
      data: { status: 'INACTIVE' },
    });

    res.json({ success: true, message: '客户已停用' });
  })
);

export default router;
