import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { certificateType, isActive, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.CertificateTemplateWhereInput = {};
    if (certificateType) where.certificateType = certificateType.toString().toUpperCase();
    if (isActive !== undefined) where.isActive = isActive === 'true' || isActive === '1';

    const [templates, total] = await Promise.all([
      prisma.certificateTemplate.findMany({
        where,
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      prisma.certificateTemplate.count({ where }),
    ]);

    res.json({
      success: true,
      data: templates.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        certificateType: t.certificateType,
        description: t.description,
        bodyTemplate: t.bodyTemplate,
        headerTemplate: t.headerTemplate,
        footerTemplate: t.footerTemplate,
        isActive: t.isActive,
        isDefault: t.isDefault,
        version: t.version,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        createdById: t.createdById,
      })),
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
  asyncHandler(async (req, res) => {
    const template = await prisma.certificateTemplate.findUnique({
      where: { id: req.params.id },
    });

    if (!template) {
      throw new AppError('证书模板不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        id: template.id,
        name: template.name,
        code: template.code,
        certificateType: template.certificateType,
        description: template.description,
        bodyTemplate: template.bodyTemplate,
        headerTemplate: template.headerTemplate,
        footerTemplate: template.footerTemplate,
        isActive: template.isActive,
        isDefault: template.isDefault,
        version: template.version,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
        createdById: template.createdById,
      },
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      name,
      code,
      certificateType,
      description,
      bodyTemplate,
      headerTemplate,
      footerTemplate,
      isActive,
      isDefault,
    } = req.body;

    if (!name || !code || !bodyTemplate) {
      throw new AppError('名称、编码和正文模板为必填项', 400, 'VALIDATION_ERROR');
    }

    if (isDefault) {
      await prisma.certificateTemplate.updateMany({
        where: {
          certificateType: certificateType?.toUpperCase() || 'AAC-038',
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    const template = await prisma.certificateTemplate.create({
      data: {
        name,
        code,
        certificateType: certificateType?.toUpperCase() || 'AAC-038',
        description: description || null,
        bodyTemplate,
        headerTemplate: headerTemplate || null,
        footerTemplate: footerTemplate || null,
        isActive: isActive !== undefined ? isActive : true,
        isDefault: isDefault || false,
        createdById: (req as AuthRequest).user?.id,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: template.id,
        name: template.name,
        code: template.code,
        certificateType: template.certificateType,
        description: template.description,
        bodyTemplate: template.bodyTemplate,
        headerTemplate: template.headerTemplate,
        footerTemplate: template.footerTemplate,
        isActive: template.isActive,
        isDefault: template.isDefault,
        version: template.version,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
        createdById: template.createdById,
      },
    });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.certificateTemplate.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('证书模板不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const {
      name,
      code,
      certificateType,
      description,
      bodyTemplate,
      headerTemplate,
      footerTemplate,
      isActive,
      isDefault,
    } = req.body;

    const nextIsDefault = isDefault ?? existing.isDefault;
    const nextCertificateType = certificateType?.toUpperCase() || existing.certificateType;

    if (nextIsDefault) {
      await prisma.certificateTemplate.updateMany({
        where: {
          certificateType: nextCertificateType,
          isDefault: true,
          id: { not: req.params.id },
        },
        data: { isDefault: false },
      });
    }

    const template = await prisma.certificateTemplate.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(code !== undefined && { code }),
        ...(certificateType !== undefined && { certificateType: certificateType.toUpperCase() }),
        ...(description !== undefined && { description }),
        ...(bodyTemplate !== undefined && { bodyTemplate }),
        ...(headerTemplate !== undefined && { headerTemplate }),
        ...(footerTemplate !== undefined && { footerTemplate }),
        ...(isActive !== undefined && { isActive }),
        ...(isDefault !== undefined && { isDefault }),
        version: existing.version + 1,
      },
    });

    res.json({
      success: true,
      data: {
        id: template.id,
        name: template.name,
        code: template.code,
        certificateType: template.certificateType,
        description: template.description,
        bodyTemplate: template.bodyTemplate,
        headerTemplate: template.headerTemplate,
        footerTemplate: template.footerTemplate,
        isActive: template.isActive,
        isDefault: template.isDefault,
        version: template.version,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
        createdById: template.createdById,
      },
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.certificateTemplate.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('证书模板不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const template = await prisma.certificateTemplate.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({
      success: true,
      data: {
        id: template.id,
        isActive: template.isActive,
      },
    });
  })
);

router.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    const existing = await prisma.certificateTemplate.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('证书模板不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const newCode = `${existing.code}-COPY-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const template = await prisma.certificateTemplate.create({
      data: {
        name: `${existing.name} (副本)`,
        code: newCode,
        certificateType: existing.certificateType,
        description: existing.description,
        bodyTemplate: existing.bodyTemplate,
        headerTemplate: existing.headerTemplate,
        footerTemplate: existing.footerTemplate,
        isActive: true,
        isDefault: false,
        createdById: (req as AuthRequest).user?.id,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: template.id,
        name: template.name,
        code: template.code,
        certificateType: template.certificateType,
        description: template.description,
        bodyTemplate: template.bodyTemplate,
        headerTemplate: template.headerTemplate,
        footerTemplate: template.footerTemplate,
        isActive: template.isActive,
        isDefault: template.isDefault,
        version: template.version,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
        createdById: template.createdById,
      },
    });
  })
);

export default router;
