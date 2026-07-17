import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { documentTemplateCreateSchema, documentTemplateUpdateSchema } from '../lib/validation.js';
import {
  ensureDefaultOrderContractTemplate,
  mapDocumentTemplate,
  ORDER_CONTRACT_DOCUMENT_TYPE,
  ORDER_CONTRACT_TEMPLATE_VARIABLES,
} from '../lib/documentTemplateService.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';

const router = Router();
router.use(requireCapability('certificate_template', 'manage'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const documentType = req.query.documentType?.toString() || ORDER_CONTRACT_DOCUMENT_TYPE;

    if (documentType === ORDER_CONTRACT_DOCUMENT_TYPE) {
      await ensureDefaultOrderContractTemplate((req as AuthRequest).user?.id);
    }

    const templates = await prisma.documentTemplate.findMany({
      where: { documentType },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });

    res.json({
      success: true,
      data: templates.map(mapDocumentTemplate),
      meta: {
        variables: ORDER_CONTRACT_TEMPLATE_VARIABLES,
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await prisma.documentTemplate.findUnique({
      where: { id: req.params.id },
    });

    if (!template) {
      throw new AppError('合同模板不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: mapDocumentTemplate(template),
      meta: {
        variables: ORDER_CONTRACT_TEMPLATE_VARIABLES,
      },
    });
  })
);

router.post(
  '/',
  validateBody(documentTemplateCreateSchema),
  asyncHandler(async (req, res) => {
    const { isDefault = false, documentType = ORDER_CONTRACT_DOCUMENT_TYPE, ...rest } = req.body;

    if (isDefault) {
      await prisma.documentTemplate.updateMany({
        where: { documentType, isDefault: true },
        data: { isDefault: false },
      });
    }

    const template = await prisma.documentTemplate.create({
      data: {
        ...rest,
        documentType,
        isDefault,
        createdById: (req as AuthRequest).user?.id,
      },
    });

    res.status(201).json({
      success: true,
      data: mapDocumentTemplate(template),
    });
  })
);

router.put(
  '/:id',
  validateBody(documentTemplateUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.documentTemplate.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('合同模板不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const nextIsDefault = req.body.isDefault ?? existing.isDefault;
    if (nextIsDefault) {
      await prisma.documentTemplate.updateMany({
        where: {
          documentType: req.body.documentType ?? existing.documentType,
          isDefault: true,
          id: { not: req.params.id },
        },
        data: { isDefault: false },
      });
    }

    const template = await prisma.documentTemplate.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        version: (req.body.version ?? existing.version) + 1,
      },
    });

    res.json({
      success: true,
      data: mapDocumentTemplate(template),
    });
  })
);

export default router;
