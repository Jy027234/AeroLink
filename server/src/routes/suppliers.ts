import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { createAuditLog } from '../middleware/auditLogger.js';
import { validateBody } from '../middleware/validate.js';
import { AuthRequest } from '../middleware/auth.js';
import { supplierCreateSchema, supplierUpdateSchema, supplierFollowUpLogBatchCreateSchema, supplierInviteSchema } from '../lib/validation.js';
import prisma from '../lib/prisma.js';
import { cache, CACHE_TTL, CACHE_KEY } from '../lib/cache.js';
import { generateAuthToken, getActivationExpiryDate } from '../lib/authFlow.js';
import { sendSupplierInviteEmail } from '../lib/authEmailService.js';
import { parseControlledExportWindow, parseListQuery, sendCsv, type SortDirection } from '../lib/listQuery.js';

function parseJsonArrayField(value: unknown): string | undefined {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

function parseDateField(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return undefined;
}

function parseJsonField(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    return [value];
  } catch {
    return value ? [value] : undefined;
  }
}

function mapSupplierResponse(s: Prisma.SupplierGetPayload<Record<string, never>>) {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    email: s.email,
    phone: s.phone,
    address: s.address,
    level: s.level,
    status: s.status,
    paymentTerms: s.paymentTerms,
    leadTime: s.leadTime,
    performanceScore: s.performanceScore,
    lastOrderDate: s.lastOrderAt?.toISOString(),
    // P2 新增字段
    supplierType: s.supplierType,
    cageCode: s.cageCode,
    caac145CertificateNo: s.caac145CertificateNo,
    caac145CertificateUrl: s.caac145CertificateUrl,
    pmaHolder: s.pmaHolder,
    ctsoaHolder: s.ctsoaHolder,
    oemAuthorized: s.oemAuthorized,
    oemAuthorizationUrl: s.oemAuthorizationUrl,
    qualityApprovalExpiry: s.qualityApprovalExpiry?.toISOString(),
    lastAuditDate: s.lastAuditDate?.toISOString(),
    nextAuditDue: s.nextAuditDue?.toISOString(),
    approvedPartCategories: parseJsonField(s.approvedPartCategories),
    specializesInAircraft: parseJsonField(s.specializesInAircraft),
    incotermsOffered: parseJsonField(s.incotermsOffered),
    leadTimeAverage: s.leadTimeAverage,
    onTimeDeliveryRate: s.onTimeDeliveryRate,
    certificateTypesProvided: parseJsonField(s.certificateTypesProvided),
    moqPolicy: s.moqPolicy,
    warrantyPolicy: s.warrantyPolicy,
    returnPolicy: s.returnPolicy,
    bankAccountInfo: s.bankAccountInfo,
  };
}

type SupplierListSort = 'name' | 'createdAt' | 'performanceScore' | 'leadTime';

function supplierListOrderBy(
  sort: SupplierListSort,
  direction: SortDirection,
): Prisma.SupplierOrderByWithRelationInput[] {
  switch (sort) {
    case 'createdAt':
      return [{ createdAt: direction }, { id: 'asc' }];
    case 'performanceScore':
      return [{ performanceScore: direction }, { id: 'asc' }];
    case 'leadTime':
      return [{ leadTime: direction }, { id: 'asc' }];
    default:
      return [{ name: direction }, { id: 'asc' }];
  }
}

function buildSupplierListWhere(query: Record<string, unknown>): Prisma.SupplierWhereInput {
  const level = typeof query.level === 'string' ? query.level : '';
  const search = typeof query.search === 'string' ? query.search : '';
  const followUpFilter = typeof query.followUpFilter === 'string' ? query.followUpFilter : 'all';
  const where: Prisma.SupplierWhereInput = {};
  if (level) where.level = level.toUpperCase();
  const searchValue = search.trim();
  if (searchValue) {
    where.OR = [
      { name: { contains: searchValue, mode: 'insensitive' } },
      { contactName: { contains: searchValue, mode: 'insensitive' } },
      { email: { contains: searchValue, mode: 'insensitive' } },
    ];
  }
  if (followUpFilter === 'with-follow-up') {
    where.followUpLogs = { some: {} };
  } else if (followUpFilter === 'waiting_quote') {
    where.followUpLogs = { some: { outcome: 'contacted_waiting_quote' } };
  } else if (followUpFilter === 'quote_promised') {
    where.followUpLogs = { some: { outcome: 'quote_promised' } };
  }
  return where;
}

const router = Router();
const SUPPLIER_FOLLOW_UP_CACHE_KEY = 'suppliers:follow-up-logs';

type SupplierFollowUpLogWithRelations = Prisma.SupplierFollowUpLogGetPayload<{
  include: {
    supplier: {
      select: {
        id: true;
        name: true;
      };
    };
    creator: {
      select: {
        id: true;
        name: true;
      };
    };
  };
}>;

function mapSupplierFollowUpLog(log: SupplierFollowUpLogWithRelations) {
  return {
    id: log.id,
    supplierId: log.supplierId,
    supplierName: log.supplier.name,
    taskId: log.taskId,
    rfqId: log.rfqId || undefined,
    rfqNumber: log.rfqNumber || undefined,
    actionType: log.actionType,
    outcome: log.outcome,
    notes: log.notes || undefined,
    preferredChannel: log.preferredChannel || undefined,
    createdAt: log.createdAt.toISOString(),
    createdBy: log.creator.name,
  };
}

router.get(
  '/',
  requireCapability('supplier', 'read'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const { page: pageNum, limit: pageSize, skip, sort, direction } = parseListQuery<SupplierListSort>(query, {
      allowedSorts: ['name', 'createdAt', 'performanceScore', 'leadTime'],
      defaultSort: 'name',
      defaultDirection: 'asc',
    });
    const level = typeof query.level === 'string' ? query.level : 'all';
    const searchValue = typeof query.search === 'string' ? query.search.trim() : '';
    const followUpFilterValue = typeof query.followUpFilter === 'string' ? query.followUpFilter : 'all';
    const cacheKey = [
      CACHE_KEY.SUPPLIER_LIST,
      level || 'all',
      searchValue || 'all',
      followUpFilterValue,
      sort,
      direction,
      pageNum,
      pageSize,
    ].join(':');

    const result = await cache.getOrSet(
      cacheKey,
      async () => {
        const where = buildSupplierListWhere(query);

        const [suppliers, total, levelCounts, performanceAggregate] = await Promise.all([
          prisma.supplier.findMany({
            where,
            orderBy: supplierListOrderBy(sort, direction),
            skip,
            take: pageSize,
          }),
          prisma.supplier.count({ where }),
          prisma.supplier.groupBy({
            by: ['level'],
            _count: { _all: true },
          }),
          prisma.supplier.aggregate({
            _avg: { performanceScore: true },
          }),
        ]);

        return {
          data: suppliers.map(mapSupplierResponse),
          summary: {
            total: levelCounts.reduce((sum, entry) => sum + entry._count._all, 0),
            s: levelCounts.find((entry) => entry.level === 'S')?._count._all || 0,
            a: levelCounts.find((entry) => entry.level === 'A')?._count._all || 0,
            b: levelCounts.find((entry) => entry.level === 'B')?._count._all || 0,
            c: levelCounts.find((entry) => entry.level === 'C')?._count._all || 0,
            avgScore: performanceAggregate._avg.performanceScore === null
              ? null
              : Math.round(performanceAggregate._avg.performanceScore),
          },
          pagination: {
            page: pageNum,
            limit: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
            sort,
            direction,
          },
        };
      },
      CACHE_TTL.SUPPLIER_LIST
    );

    res.json({
      success: true,
      ...result,
    });
  })
);

router.get(
  '/export.csv',
  requireCapability('supplier', 'export'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const window = parseControlledExportWindow(query);
    const { sort, direction } = parseListQuery<SupplierListSort>(query, {
      allowedSorts: ['name', 'createdAt', 'performanceScore', 'leadTime'],
      defaultSort: 'name',
      defaultDirection: 'asc',
    });
    const suppliers = await prisma.supplier.findMany({
      where: buildSupplierListWhere(query),
      select: {
        name: true,
        level: true,
        status: true,
        contactName: true,
        email: true,
        phone: true,
        performanceScore: true,
        leadTime: true,
        lastOrderAt: true,
        createdAt: true,
      },
      orderBy: supplierListOrderBy(sort, direction),
      skip: window.skip,
      take: window.take,
    });

    await createAuditLog({
      req,
      action: 'EXPORT',
      resourceType: 'SUPPLIER',
      details: `Supplier CSV export (${window.scope}, ${suppliers.length}/${window.rowLimit} rows)`,
    });
    sendCsv(
      res,
      `suppliers-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { header: '供应商名称', value: (supplier) => supplier.name },
        { header: '等级', value: (supplier) => supplier.level },
        { header: '状态', value: (supplier) => supplier.status },
        { header: '联系人', value: (supplier) => supplier.contactName },
        { header: '邮箱', value: (supplier) => supplier.email },
        { header: '电话', value: (supplier) => supplier.phone },
        { header: '绩效评分', value: (supplier) => supplier.performanceScore },
        { header: '交期（天）', value: (supplier) => supplier.leadTime },
        { header: '最近订单日期', value: (supplier) => supplier.lastOrderAt },
        { header: '创建时间', value: (supplier) => supplier.createdAt },
      ],
      suppliers,
      window,
    );
  }),
);

router.get(
  '/follow-up-logs',
  requireCapability('supplier', 'read'),
  asyncHandler(async (req, res) => {
    const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 200));
    const cacheKey = `${SUPPLIER_FOLLOW_UP_CACHE_KEY}:${supplierId || 'all'}:${limit}`;

    const logs = await cache.getOrSet(
      cacheKey,
      async () => {
        const where: Prisma.SupplierFollowUpLogWhereInput = supplierId ? { supplierId } : {};
        return prisma.supplierFollowUpLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: {
            supplier: {
              select: {
                id: true,
                name: true,
              },
            },
            creator: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });
      },
      CACHE_TTL.SUPPLIER_DETAIL
    );

    res.json({
      success: true,
      data: logs.map(mapSupplierFollowUpLog),
    });
  })
);

router.post(
  '/follow-up-logs',
  requireCapability('supplier_quote', 'create'),
  validateBody(supplierFollowUpLogBatchCreateSchema),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthRequest;
    if (!authReq.user) {
      throw new AppError('未授权，请先登录', 401);
    }

    const incomingLogs = req.body.logs as Array<{
      supplierId: string;
      taskId: string;
      rfqId?: string;
      rfqNumber?: string;
      actionType: string;
      outcome: string;
      notes?: string;
      preferredChannel?: 'email' | 'phone' | 'manual';
    }>;

    const supplierIds = Array.from(new Set(incomingLogs.map((log) => log.supplierId)));
    const suppliers = await prisma.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true },
    });

    if (suppliers.length !== supplierIds.length) {
      const existingIds = new Set(suppliers.map((supplier) => supplier.id));
      const missingIds = supplierIds.filter((id) => !existingIds.has(id));
      throw new AppError(`供应商不存在: ${missingIds.join(', ')}`, 404);
    }

    const createdLogs = await prisma.$transaction(
      incomingLogs.map((log) =>
        prisma.supplierFollowUpLog.create({
          data: {
            supplierId: log.supplierId,
            taskId: log.taskId,
            rfqId: log.rfqId || null,
            rfqNumber: log.rfqNumber || null,
            actionType: log.actionType,
            outcome: log.outcome,
            notes: log.notes || null,
            preferredChannel: log.preferredChannel || null,
            createdById: authReq.user!.id,
          },
          include: {
            supplier: {
              select: {
                id: true,
                name: true,
              },
            },
            creator: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        })
      )
    );

    cache.delByPrefix(SUPPLIER_FOLLOW_UP_CACHE_KEY);
    supplierIds.forEach((id) => cache.del(CACHE_KEY.SUPPLIER_DETAIL(id)));

    res.status(201).json({
      success: true,
      data: createdLogs.map(mapSupplierFollowUpLog),
    });
  })
);

router.get(
  '/:id',
  requireCapability('supplier', 'read'),
  asyncHandler(async (req, res) => {
    const cacheKey = CACHE_KEY.SUPPLIER_DETAIL(req.params.id);

    const data = await cache.getOrSet(
      cacheKey,
      async () => {
        const supplier = await prisma.supplier.findUnique({
          where: { id: req.params.id },
          include: {
            inventory: true,
            inquiries: true,
            portalUsers: true,
          },
        });

        if (!supplier) {
          throw new AppError('供应商不存在', 404);
        }

        return supplier;
      },
      CACHE_TTL.SUPPLIER_DETAIL
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.post(
  '/',
  requireCapability('supplier', 'create'),
  validateBody(supplierCreateSchema),
  asyncHandler(async (req, res) => {
    const {
      name, contactName, level, paymentTerms, leadTime,
      supplierType, cageCode, caac145CertificateNo, caac145CertificateUrl,
      pmaHolder, ctsoaHolder, oemAuthorized, oemAuthorizationUrl,
      qualityApprovalExpiry, lastAuditDate, nextAuditDue,
      approvedPartCategories, specializesInAircraft, incotermsOffered,
      leadTimeAverage, onTimeDeliveryRate, certificateTypesProvided,
      moqPolicy, warrantyPolicy, returnPolicy, bankAccountInfo,
    } = req.body;
    const email = typeof req.body.email === 'string' ? req.body.email.trim() || undefined : undefined;
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() || undefined : undefined;
    const address = typeof req.body.address === 'string' ? req.body.address.trim() || undefined : undefined;

    if (email) {
      const existing = await prisma.supplier.findUnique({ where: { email } });
      if (existing) {
        throw new AppError('该邮箱已关联供应商', 409);
      }
    }

    const supplier = await prisma.supplier.create({
      data: {
        name,
        contactName,
        email: email || null,
        phone: phone || null,
        address: address || null,
        level: (level || 'C').toString().toUpperCase(),
        paymentTerms: paymentTerms || null,
        leadTime: typeof leadTime === 'number' ? leadTime : null,
        status: 'active',
        // P2 新增字段
        supplierType: supplierType || 'Distributor',
        cageCode: cageCode || null,
        caac145CertificateNo: caac145CertificateNo || null,
        caac145CertificateUrl: caac145CertificateUrl || null,
        pmaHolder: typeof pmaHolder === 'boolean' ? pmaHolder : false,
        ctsoaHolder: typeof ctsoaHolder === 'boolean' ? ctsoaHolder : false,
        oemAuthorized: typeof oemAuthorized === 'boolean' ? oemAuthorized : false,
        oemAuthorizationUrl: oemAuthorizationUrl || null,
        qualityApprovalExpiry: parseDateField(qualityApprovalExpiry) || null,
        lastAuditDate: parseDateField(lastAuditDate) || null,
        nextAuditDue: parseDateField(nextAuditDue) || null,
        approvedPartCategories: parseJsonArrayField(approvedPartCategories) || null,
        specializesInAircraft: parseJsonArrayField(specializesInAircraft) || null,
        incotermsOffered: parseJsonArrayField(incotermsOffered) || null,
        leadTimeAverage: typeof leadTimeAverage === 'number' ? leadTimeAverage : null,
        onTimeDeliveryRate: typeof onTimeDeliveryRate === 'number' ? onTimeDeliveryRate : null,
        certificateTypesProvided: parseJsonArrayField(certificateTypesProvided) || null,
        moqPolicy: moqPolicy || null,
        warrantyPolicy: warrantyPolicy || null,
        returnPolicy: returnPolicy || null,
        bankAccountInfo: bankAccountInfo || null,
      },
    });

    cache.delByPrefix(CACHE_KEY.SUPPLIER_LIST);

    res.status(201).json({
      success: true,
      data: mapSupplierResponse(supplier),
    });
  })
);

router.patch(
  '/:id',
  requireCapability('supplier', 'update'),
  validateBody(supplierUpdateSchema),
  asyncHandler(async (req, res) => {
    const {
      name, contactName, level, paymentTerms, leadTime,
      supplierType, cageCode, caac145CertificateNo, caac145CertificateUrl,
      pmaHolder, ctsoaHolder, oemAuthorized, oemAuthorizationUrl,
      qualityApprovalExpiry, lastAuditDate, nextAuditDue,
      approvedPartCategories, specializesInAircraft, incotermsOffered,
      leadTimeAverage, onTimeDeliveryRate, certificateTypesProvided,
      moqPolicy, warrantyPolicy, returnPolicy, bankAccountInfo,
    } = req.body;
    const email = typeof req.body.email === 'string' ? req.body.email.trim() || undefined : undefined;
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() || undefined : undefined;
    const address = typeof req.body.address === 'string' ? req.body.address.trim() || undefined : undefined;

    const existing = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('供应商不存在', 404);
    }

    if (email && email !== existing.email) {
      const duplicate = await prisma.supplier.findUnique({ where: { email } });
      if (duplicate) {
        throw new AppError('该邮箱已关联其他供应商', 409);
      }
    }

    const data: Prisma.SupplierUpdateInput = {};
    if (name !== undefined) data.name = name;
    if (contactName !== undefined) data.contactName = contactName || null;
    if (email !== undefined) data.email = email || null;
    if (phone !== undefined) data.phone = phone || null;
    if (address !== undefined) data.address = address || null;
    if (level !== undefined) data.level = level.toString().toUpperCase();
    if (paymentTerms !== undefined) data.paymentTerms = paymentTerms || null;
    if (leadTime !== undefined) data.leadTime = typeof leadTime === 'number' ? leadTime : null;
    if (supplierType !== undefined) data.supplierType = supplierType || 'Distributor';
    if (cageCode !== undefined) data.cageCode = cageCode || null;
    if (caac145CertificateNo !== undefined) data.caac145CertificateNo = caac145CertificateNo || null;
    if (caac145CertificateUrl !== undefined) data.caac145CertificateUrl = caac145CertificateUrl || null;
    if (pmaHolder !== undefined) data.pmaHolder = typeof pmaHolder === 'boolean' ? pmaHolder : false;
    if (ctsoaHolder !== undefined) data.ctsoaHolder = typeof ctsoaHolder === 'boolean' ? ctsoaHolder : false;
    if (oemAuthorized !== undefined) data.oemAuthorized = typeof oemAuthorized === 'boolean' ? oemAuthorized : false;
    if (oemAuthorizationUrl !== undefined) data.oemAuthorizationUrl = oemAuthorizationUrl || null;
    if (qualityApprovalExpiry !== undefined) data.qualityApprovalExpiry = parseDateField(qualityApprovalExpiry) || null;
    if (lastAuditDate !== undefined) data.lastAuditDate = parseDateField(lastAuditDate) || null;
    if (nextAuditDue !== undefined) data.nextAuditDue = parseDateField(nextAuditDue) || null;
    if (approvedPartCategories !== undefined) data.approvedPartCategories = parseJsonArrayField(approvedPartCategories) || null;
    if (specializesInAircraft !== undefined) data.specializesInAircraft = parseJsonArrayField(specializesInAircraft) || null;
    if (incotermsOffered !== undefined) data.incotermsOffered = parseJsonArrayField(incotermsOffered) || null;
    if (leadTimeAverage !== undefined) data.leadTimeAverage = typeof leadTimeAverage === 'number' ? leadTimeAverage : null;
    if (onTimeDeliveryRate !== undefined) data.onTimeDeliveryRate = typeof onTimeDeliveryRate === 'number' ? onTimeDeliveryRate : null;
    if (certificateTypesProvided !== undefined) data.certificateTypesProvided = parseJsonArrayField(certificateTypesProvided) || null;
    if (moqPolicy !== undefined) data.moqPolicy = moqPolicy || null;
    if (warrantyPolicy !== undefined) data.warrantyPolicy = warrantyPolicy || null;
    if (returnPolicy !== undefined) data.returnPolicy = returnPolicy || null;
    if (bankAccountInfo !== undefined) data.bankAccountInfo = bankAccountInfo || null;

    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data,
    });

    cache.delByPrefix(CACHE_KEY.SUPPLIER_LIST);
    cache.del(CACHE_KEY.SUPPLIER_DETAIL(req.params.id));

    res.json({
      success: true,
      data: mapSupplierResponse(supplier),
    });
  })
);

router.post(
  '/invite',
  requireCapability('supplier', 'create'),
  validateBody(supplierInviteSchema),
  asyncHandler(async (req, res) => {
    const { email, message } = req.body;
    void message;

    // 检查是否已存在该邮箱的供应商
    const existing = await prisma.supplier.findFirst({
      where: { email },
    });

    if (existing) {
      throw new AppError('该邮箱已关联供应商', 409);
    }

    const token = generateAuthToken();
    const expiresAt = getActivationExpiryDate();

    // 创建待激活的供应商记录
    const supplier = await prisma.supplier.create({
      data: {
        name: email.split('@')[0],
        email,
        level: 'C',
        performanceScore: 50,
        status: 'pending',
        activationToken: token,
        activationTokenExpiresAt: expiresAt,
      },
    });

    // 清除供应商列表缓存
    cache.delByPrefix(CACHE_KEY.SUPPLIER_LIST);

    // 发送邀请邮件
    const emailResult = await sendSupplierInviteEmail(
      supplier.name,
      supplier.email!,
      token,
      expiresAt
    );

    res.status(201).json({
      success: true,
      message: '邀请已发送',
      data: {
        id: supplier.id,
        email: supplier.email,
        status: supplier.status,
        emailDeliveryStatus: emailResult.emailDeliveryStatus,
      },
    });
  })
);

router.delete(
  '/:id',
  requireCapability('supplier', 'delete'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('供应商不存在', 404);
    }

    await prisma.supplier.update({
      where: { id: req.params.id },
      data: { status: 'inactive' },
    });

    cache.delByPrefix(CACHE_KEY.SUPPLIER_LIST);
    cache.del(CACHE_KEY.SUPPLIER_DETAIL(req.params.id));

    res.json({ success: true, message: '供应商已停用' });
  })
);

export default router;
