import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { requireRole } from '../middleware/rbac.js';
import { inventoryUpdateSchema, inventoryCreateSchema } from '../lib/validation.js';
import { SocketEvents, SocketRooms, emitToRoom } from '../lib/socketEvents.js';
import { loadInventoryReconciliation } from '../lib/inventoryReconciliation.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { partNumber, search, conditionCode, certificateType, type, partCategory, location, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.InventoryWhereInput = {};
    const searchValue = typeof search === 'string' ? search.trim() : '';
    if (searchValue) {
      where.OR = [
        { partNumber: { contains: searchValue, mode: 'insensitive' } },
        { description: { contains: searchValue, mode: 'insensitive' } },
        { serialNumber: { contains: searchValue, mode: 'insensitive' } },
        { batchNumber: { contains: searchValue, mode: 'insensitive' } },
        { manufacturer: { contains: searchValue, mode: 'insensitive' } },
      ];
    } else if (partNumber) {
      where.partNumber = { contains: partNumber.toString() };
    }
    if (conditionCode) where.conditionCode = conditionCode.toString().toUpperCase();
    if (certificateType) where.certificateType = certificateType.toString().toUpperCase();
    if (type) where.type = type.toString().toUpperCase();
    if (partCategory) where.partCategory = partCategory.toString().toUpperCase();
    if (location) where.location = location.toString();

    const [inventory, total, categoryCounts, valueRows, locationCounts] = await Promise.all([
      prisma.inventory.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
        },
        orderBy: { partNumber: 'asc' },
        skip,
        take: pageSize,
      }),
      prisma.inventory.count({ where }),
      prisma.inventory.groupBy({
        by: ['partCategory'],
        _count: { _all: true },
      }),
      prisma.inventory.findMany({
        select: { quantity: true, unitCost: true },
      }),
      prisma.inventory.groupBy({
        by: ['location'],
        _count: { _all: true },
      }),
    ]);

    const categoryCount = (category: string) =>
      categoryCounts.find((entry) => entry.partCategory === category)?._count._all || 0;
    const summary = {
      total: categoryCounts.reduce((sum, entry) => sum + entry._count._all, 0),
      rotable: categoryCount('ROTABLE'),
      repairable: categoryCount('REPAIRABLE'),
      chemical: categoryCount('CHEMICAL'),
      standardPart: categoryCount('STANDARD_PART'),
      rawMaterial: categoryCount('RAW_MATERIAL'),
      consumable: categoryCount('CONSUMABLE'),
      totalValue: valueRows.reduce((sum, item) => sum + item.quantity * item.unitCost, 0),
      locations: locationCounts.map((entry) => entry.location).filter(Boolean).sort(),
    };

    res.json({
      success: true,
      data: inventory.map((item) => ({
        id: item.id,
        partNumber: item.partNumber,
        description: item.description,
        quantity: item.quantity,
        location: item.location,
        warehouse: item.warehouse,
        shelf: item.shelf,
        conditionCode: item.conditionCode,
        certificateType: item.certificateType,
        certificateNumber: item.certificateNumber,
        certificateFileUrl: item.certificateFileUrl,
        serialNumber: item.serialNumber,
        batchNumber: item.batchNumber,
        manufacturer: item.manufacturer,
        manufacturerCageCode: item.manufacturerCageCode,
        ataChapter: item.ataChapter,
        alternatePartNumbers: item.alternatePartNumbers,
        partCategory: item.partCategory,
        trackingType: item.trackingType,
        unitOfMeasure: item.unitOfMeasure,
        countryOfOrigin: item.countryOfOrigin,
        hsCode: item.hsCode,
        type: item.type.toLowerCase(),
        unitCost: item.unitCost,
        supplierId: item.supplierId,
        supplierName: item.supplier?.name,
        eta: item.eta?.toISOString(),
        createdAt: item.createdAt.toISOString(),
        // 时寿件管理（P1）
        lifeLimited: item.lifeLimited,
        totalHours: item.totalHours,
        totalCycles: item.totalCycles,
        remainingHours: item.remainingHours,
        remainingCycles: item.remainingCycles,
        manufactureDate: item.manufactureDate?.toISOString(),
        shelfLifeDate: item.shelfLifeDate?.toISOString(),
        overhaulDate: item.overhaulDate?.toISOString(),
        nextOverhaulDue: item.nextOverhaulDue?.toISOString(),
        adStatus: item.adStatus,
        sbStatus: item.sbStatus,
        repairScheme: item.repairScheme,
        // 二手件追溯（P2）
        previousOperator: item.previousOperator,
        removalAircraftReg: item.removalAircraftReg,
        removalDate: item.removalDate?.toISOString(),
        removalReason: item.removalReason,
        nonIncidentStatement: item.nonIncidentStatement,
        militarySource: item.militarySource,
        traceabilityDocs: item.traceabilityDocs,
        // 存储与包装（P2）
        storageCondition: item.storageCondition,
        ata300Packaging: item.ata300Packaging,
        shelfLifeDays: item.shelfLifeDays,
        storageTempMin: item.storageTempMin,
        storageTempMax: item.storageTempMax,
        hazardClass: item.hazardClass,
      })),
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
  '/reconciliation',
  requireRole('manager', 'admin'),
  asyncHandler(async (_req, res) => {
    try {
      const result = await loadInventoryReconciliation();
      res.json({
        success: true,
        data: {
          ...result,
          status: result.mismatches.length === 0 ? 'PASS' : 'MISMATCH',
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
        throw new AppError('库存对账依赖的表尚未就绪', 503, 'BAD_REQUEST');
      }
      throw error;
    }
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const item = await prisma.inventory.findUnique({
      where: { id: req.params.id },
      include: { supplier: true },
    });

    if (!item) {
      throw new AppError('库存不存在', 404);
    }

    res.json({
      success: true,
      data: {
        ...item,
        certificateType: item.certificateType,
        type: item.type.toLowerCase(),
        // 时寿件管理（P1）
        lifeLimited: item.lifeLimited,
        totalHours: item.totalHours,
        totalCycles: item.totalCycles,
        remainingHours: item.remainingHours,
        remainingCycles: item.remainingCycles,
        manufactureDate: item.manufactureDate?.toISOString(),
        shelfLifeDate: item.shelfLifeDate?.toISOString(),
        overhaulDate: item.overhaulDate?.toISOString(),
        nextOverhaulDue: item.nextOverhaulDue?.toISOString(),
        adStatus: item.adStatus,
        sbStatus: item.sbStatus,
        repairScheme: item.repairScheme,
        // 二手件追溯（P2）
        previousOperator: item.previousOperator,
        removalAircraftReg: item.removalAircraftReg,
        removalDate: item.removalDate?.toISOString(),
        removalReason: item.removalReason,
        nonIncidentStatement: item.nonIncidentStatement,
        militarySource: item.militarySource,
        traceabilityDocs: item.traceabilityDocs,
        // 存储与包装（P2）
        storageCondition: item.storageCondition,
        ata300Packaging: item.ata300Packaging,
      },
    });
  })
);

router.get(
  '/part/:partNumber',
  asyncHandler(async (req, res) => {
    const items = await prisma.inventory.findMany({
      where: { partNumber: req.params.partNumber },
      include: { supplier: { select: { id: true, name: true } } },
    });

    res.json({
      success: true,
      data: items.map((item) => ({
        ...item,
        certificateType: item.certificateType,
        type: item.type.toLowerCase(),
        supplierName: item.supplier?.name,
      })),
    });
  })
);

router.patch(
  '/:id',
  requireRole('manager', 'admin'),
  validateBody(inventoryUpdateSchema),
  asyncHandler(async (req, res) => {
    const {
      quantity,
      location,
      warehouse,
      shelf,
      conditionCode,
      certificateType,
      certificateNumber,
      certificateFileUrl,
      serialNumber,
      batchNumber,
      manufacturer,
      manufacturerCageCode,
      ataChapter,
      alternatePartNumbers,
      unitOfMeasure,
      countryOfOrigin,
      hsCode,
      // 时寿件管理（P1）
      lifeLimited,
      totalHours,
      totalCycles,
      remainingHours,
      remainingCycles,
      manufactureDate,
      shelfLifeDate,
      overhaulDate,
      nextOverhaulDue,
      adStatus,
      sbStatus,
      repairScheme,
      // 二手件追溯（P2）
      previousOperator,
      removalAircraftReg,
      removalDate,
      removalReason,
      nonIncidentStatement,
      militarySource,
      traceabilityDocs,
      // 存储与包装（P2）
      storageCondition,
      ata300Packaging,
    } = req.body;

    const toDate = (value: string | undefined): Date | undefined => {
      if (!value) return undefined;
      const d = new Date(value);
      return isNaN(d.getTime()) ? undefined : d;
    };

    const item = await prisma.inventory.update({
      where: { id: req.params.id },
      data: {
        ...(quantity !== undefined && { quantity }),
        ...(location !== undefined && { location }),
        ...(warehouse !== undefined && { warehouse }),
        ...(shelf !== undefined && { shelf }),
        ...(conditionCode !== undefined && { conditionCode: conditionCode.toUpperCase() }),
        ...(certificateType !== undefined && { certificateType: certificateType.toUpperCase() }),
        ...(certificateNumber !== undefined && { certificateNumber }),
        ...(certificateFileUrl !== undefined && { certificateFileUrl }),
        ...(serialNumber !== undefined && { serialNumber }),
        ...(batchNumber !== undefined && { batchNumber }),
        ...(manufacturer !== undefined && { manufacturer }),
        ...(manufacturerCageCode !== undefined && { manufacturerCageCode }),
        ...(ataChapter !== undefined && { ataChapter }),
        ...(alternatePartNumbers !== undefined && { alternatePartNumbers }),
        ...(unitOfMeasure !== undefined && { unitOfMeasure: unitOfMeasure.toUpperCase() }),
        ...(countryOfOrigin !== undefined && { countryOfOrigin }),
        ...(hsCode !== undefined && { hsCode }),
        // 时寿件管理（P1）
        ...(lifeLimited !== undefined && { lifeLimited }),
        ...(totalHours !== undefined && { totalHours }),
        ...(totalCycles !== undefined && { totalCycles }),
        ...(remainingHours !== undefined && { remainingHours }),
        ...(remainingCycles !== undefined && { remainingCycles }),
        ...(manufactureDate !== undefined && { manufactureDate: toDate(manufactureDate) }),
        ...(shelfLifeDate !== undefined && { shelfLifeDate: toDate(shelfLifeDate) }),
        ...(overhaulDate !== undefined && { overhaulDate: toDate(overhaulDate) }),
        ...(nextOverhaulDue !== undefined && { nextOverhaulDue: toDate(nextOverhaulDue) }),
        ...(adStatus !== undefined && { adStatus }),
        ...(sbStatus !== undefined && { sbStatus }),
        ...(repairScheme !== undefined && { repairScheme }),
        // 二手件追溯（P2）
        ...(previousOperator !== undefined && { previousOperator }),
        ...(removalAircraftReg !== undefined && { removalAircraftReg }),
        ...(removalDate !== undefined && { removalDate: toDate(removalDate) }),
        ...(removalReason !== undefined && { removalReason }),
        ...(nonIncidentStatement !== undefined && { nonIncidentStatement }),
        ...(militarySource !== undefined && { militarySource }),
        ...(traceabilityDocs !== undefined && { traceabilityDocs }),
        // 存储与包装（P2）
        ...(storageCondition !== undefined && { storageCondition }),
        ...(ata300Packaging !== undefined && { ata300Packaging }),
      },
    });

    emitToRoom(SocketRooms.INVENTORY, SocketEvents.INVENTORY_UPDATED, {
      id: item.id,
      partNumber: item.partNumber,
      quantity: item.quantity,
      conditionCode: item.conditionCode,
    });

    res.json({
      success: true,
      data: {
        ...item,
        certificateType: item.certificateType,
        type: item.type.toLowerCase(),
      },
    });
  })
);

router.post(
  '/',
  requireRole('manager', 'admin'),
  validateBody(inventoryCreateSchema),
  asyncHandler(async (req, res) => {
    const {
      partNumber,
      description,
      quantity,
      location,
      warehouse,
      shelf,
      conditionCode,
      certificateType,
      certificateNumber,
      certificateFileUrl,
      serialNumber,
      batchNumber,
      manufacturer,
      manufacturerCageCode,
      ataChapter,
      alternatePartNumbers,
      unitOfMeasure,
      countryOfOrigin,
      hsCode,
      unitCost,
      type,
      supplierId,
      // 时寿件管理（P1）
      lifeLimited,
      totalHours,
      totalCycles,
      remainingHours,
      remainingCycles,
      manufactureDate,
      shelfLifeDate,
      overhaulDate,
      nextOverhaulDue,
      adStatus,
      sbStatus,
      repairScheme,
      // 二手件追溯（P2）
      previousOperator,
      removalAircraftReg,
      removalDate,
      removalReason,
      nonIncidentStatement,
      militarySource,
      traceabilityDocs,
      // 存储与包装（P2）
      storageCondition,
      ata300Packaging,
    } = req.body;

    const toDate = (value: string | undefined): Date | undefined => {
      if (!value) return undefined;
      const d = new Date(value);
      return isNaN(d.getTime()) ? undefined : d;
    };

    const item = await prisma.inventory.create({
      data: {
        partNumber,
        description,
        quantity: quantity ?? 0,
        location,
        warehouse,
        shelf,
        conditionCode: conditionCode?.toUpperCase() ?? 'NE',
        certificateType: certificateType?.toUpperCase() ?? 'NONE',
        certificateNumber,
        certificateFileUrl,
        serialNumber,
        batchNumber,
        manufacturer,
        manufacturerCageCode,
        ataChapter,
        alternatePartNumbers,
        unitOfMeasure: unitOfMeasure?.toUpperCase() ?? 'EA',
        countryOfOrigin,
        hsCode,
        unitCost: unitCost ?? 0,
        type: type?.toUpperCase() ?? 'OWN',
        supplierId,
        // 时寿件管理（P1）
        lifeLimited: lifeLimited ?? false,
        totalHours,
        totalCycles,
        remainingHours,
        remainingCycles,
        manufactureDate: toDate(manufactureDate),
        shelfLifeDate: toDate(shelfLifeDate),
        overhaulDate: toDate(overhaulDate),
        nextOverhaulDue: toDate(nextOverhaulDue),
        adStatus,
        sbStatus,
        repairScheme,
        // 二手件追溯（P2）
        previousOperator,
        removalAircraftReg,
        removalDate: toDate(removalDate),
        removalReason,
        nonIncidentStatement: nonIncidentStatement ?? false,
        militarySource: militarySource ?? false,
        traceabilityDocs,
        // 存储与包装（P2）
        storageCondition,
        ata300Packaging: ata300Packaging ?? false,
      },
    });

    emitToRoom(SocketRooms.INVENTORY, SocketEvents.INVENTORY_UPDATED, {
      id: item.id,
      partNumber: item.partNumber,
      quantity: item.quantity,
      conditionCode: item.conditionCode,
    });

    res.json({
      success: true,
      data: {
        ...item,
        certificateType: item.certificateType,
        type: item.type.toLowerCase(),
      },
    });
  })
);

router.delete(
  '/:id',
  requireRole('manager', 'admin'),
  asyncHandler(async (req, res) => {
    const item = await prisma.inventory.findUnique({ where: { id: req.params.id } });
    if (!item) {
      throw new AppError('库存不存在', 404);
    }

    await prisma.inventory.delete({ where: { id: req.params.id } });

    emitToRoom(SocketRooms.INVENTORY, SocketEvents.INVENTORY_UPDATED, {
      id: item.id,
      partNumber: item.partNumber,
      action: 'deleted',
    });

    res.json({ success: true, message: '库存已删除' });
  })
);

export default router;
