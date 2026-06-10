import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireRole } from '../middleware/rbac.js';
import { validateBody } from '../middleware/validate.js';
import { AuthRequest } from '../middleware/auth.js';
import { supplierCreateSchema, supplierUpdateSchema, supplierFollowUpLogBatchCreateSchema, supplierInviteSchema } from '../lib/validation.js';
import prisma from '../lib/prisma.js';
import { cache, CACHE_TTL, CACHE_KEY } from '../lib/cache.js';

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
  asyncHandler(async (req, res) => {
    const { level, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const cacheKey = `${CACHE_KEY.SUPPLIER_LIST}:${level || 'all'}:${pageNum}:${pageSize}`;

    const result = await cache.getOrSet(
      cacheKey,
      async () => {
        const where: Prisma.SupplierWhereInput = {};
        if (level) where.level = level.toString().toUpperCase();

        const [suppliers, total] = await Promise.all([
          prisma.supplier.findMany({
            where,
            orderBy: { name: 'asc' },
            skip,
            take: pageSize,
          }),
          prisma.supplier.count({ where }),
        ]);

        return {
          data: suppliers.map(mapSupplierResponse),
          pagination: {
            page: pageNum,
            limit: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
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
  '/follow-up-logs',
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
  requireRole('sales'),
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
  requireRole('manager', 'admin'),
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
  requireRole('manager', 'admin'),
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
  requireRole('manager', 'admin'),
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

    // 创建待激活的供应商记录
    const supplier = await prisma.supplier.create({
      data: {
        name: email.split('@')[0],
        email,
        level: 'C',
        performanceScore: 50,
        status: 'pending',
      },
    });

    // 清除供应商列表缓存
    cache.delByPrefix(CACHE_KEY.SUPPLIER_LIST);

    // TODO: 发送邀请邮件
    // await sendInviteEmail(email, message);

    res.status(201).json({
      success: true,
      message: '邀请已发送',
      data: {
        id: supplier.id,
        email: supplier.email,
        status: supplier.status,
      },
    });
  })
);

router.delete(
  '/:id',
  requireRole('manager', 'admin'),
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
