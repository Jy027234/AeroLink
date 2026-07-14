import { Router, type NextFunction, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requirePrivilegedRole } from '../lib/accessControl.js';
import prisma from '../lib/prisma.js';
import { requireSanitizedTemplateHtml, sanitizeTemplateHtml } from '../lib/templateSanitizer.js';

const router = Router();

const requireTemplateAdmin = (req: AuthRequest, _res: Response, next: NextFunction) => {
  requirePrivilegedRole(req, '无权操作，仅管理员或总经理可管理证书模板');
  next();
};

function serializeTemplate(template: {
  id: string;
  name: string;
  code: string;
  certificateType: string;
  description: string | null;
  bodyTemplate: string;
  headerTemplate: string | null;
  footerTemplate: string | null;
  isActive: boolean;
  isDefault: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
}) {
  return {
    id: template.id,
    name: template.name,
    code: template.code,
    certificateType: template.certificateType,
    description: template.description,
    bodyTemplate: sanitizeTemplateHtml(template.bodyTemplate) ?? '',
    headerTemplate: sanitizeTemplateHtml(template.headerTemplate),
    footerTemplate: sanitizeTemplateHtml(template.footerTemplate),
    isActive: template.isActive,
    isDefault: template.isDefault,
    version: template.version,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    createdById: template.createdById,
  };
}

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
      data: templates.map(serializeTemplate),
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
      data: serializeTemplate(template),
    });
  })
);

router.post(
  '/',
  requireTemplateAdmin,
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

    let sanitizedBodyTemplate: string;
    try {
      sanitizedBodyTemplate = requireSanitizedTemplateHtml(bodyTemplate, '正文模板');
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : '正文模板无效', 400, 'VALIDATION_ERROR');
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
        bodyTemplate: sanitizedBodyTemplate,
        headerTemplate: sanitizeTemplateHtml(headerTemplate),
        footerTemplate: sanitizeTemplateHtml(footerTemplate),
        isActive: isActive !== undefined ? isActive : true,
        isDefault: isDefault || false,
        createdById: (req as AuthRequest).user?.id,
      },
    });

    res.status(201).json({
      success: true,
      data: serializeTemplate(template),
    });
  })
);

router.put(
  '/:id',
  requireTemplateAdmin,
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

    let sanitizedBodyTemplate: string | undefined;
    try {
      if (bodyTemplate !== undefined) {
        sanitizedBodyTemplate = requireSanitizedTemplateHtml(bodyTemplate, '正文模板');
      }
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : '正文模板无效', 400, 'VALIDATION_ERROR');
    }

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
        ...(sanitizedBodyTemplate !== undefined && { bodyTemplate: sanitizedBodyTemplate }),
        ...(headerTemplate !== undefined && { headerTemplate: sanitizeTemplateHtml(headerTemplate) }),
        ...(footerTemplate !== undefined && { footerTemplate: sanitizeTemplateHtml(footerTemplate) }),
        ...(isActive !== undefined && { isActive }),
        ...(isDefault !== undefined && { isDefault }),
        version: existing.version + 1,
      },
    });

    res.json({
      success: true,
      data: serializeTemplate(template),
    });
  })
);

router.delete(
  '/:id',
  requireTemplateAdmin,
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
  requireTemplateAdmin,
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
        bodyTemplate: requireSanitizedTemplateHtml(existing.bodyTemplate, '正文模板'),
        headerTemplate: sanitizeTemplateHtml(existing.headerTemplate),
        footerTemplate: sanitizeTemplateHtml(existing.footerTemplate),
        isActive: true,
        isDefault: false,
        createdById: (req as AuthRequest).user?.id,
      },
    });

    res.status(201).json({
      success: true,
      data: serializeTemplate(template),
    });
  })
);

export default router;
