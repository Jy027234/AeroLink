import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';
import { objectStorage } from '../lib/objectStorage.js';
import { AuthRequest } from '../middleware/auth.js';
import { recordOperationalAlert } from '../lib/alerting.js';

const router = Router();

export function canReadStoredObject(
  storedObject: { ownerId: string | null },
  user: { id?: string; role?: string } | undefined,
) {
  const role = user?.role?.toLowerCase();
  const privileged = role === 'admin' || role === 'manager';
  return privileged || Boolean(user?.id && storedObject.ownerId === user.id);
}

export function contentDisposition(filename?: string | null) {
  const fallback = (filename || 'download').replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename || fallback);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

router.get('/:id', asyncHandler(async (req: AuthRequest, res) => {
  const storedObject = await prisma.storedObject.findUnique({ where: { id: req.params.id } });
  if (!storedObject || storedObject.status !== 'AVAILABLE') {
    throw new AppError('文件不存在或不可用', 404, 'RESOURCE_NOT_FOUND');
  }
  if (!canReadStoredObject(storedObject, req.user)) {
    throw new AppError('无权访问此文件', 403, 'AUTH_FORBIDDEN');
  }

  let stream;
  try {
    stream = await objectStorage.createReadStream(storedObject.objectKey);
  } catch {
    recordOperationalAlert({
      key: 'object-storage.missing-object',
      severity: 'critical',
      title: 'Object storage object missing',
      message: 'A stored file metadata record points to an unavailable object.',
      source: 'object-storage',
      metadata: { objectId: storedObject.id },
    });
    throw new AppError('文件对象不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  res.setHeader('Content-Type', storedObject.mimeType);
  res.setHeader('Content-Length', String(storedObject.sizeBytes));
  res.setHeader('Content-Disposition', contentDisposition(storedObject.originalName));
  stream.on('error', () => {
    recordOperationalAlert({
      key: 'object-storage.missing-object',
      severity: 'critical',
      title: 'Object storage stream failed',
      message: 'A stored file stream failed while serving an authorized download.',
      source: 'object-storage',
      metadata: { objectId: storedObject.id },
    });
    if (!res.headersSent) res.status(404).json({ message: '文件对象不存在', code: 'RESOURCE_NOT_FOUND' });
    else res.destroy();
  });
  stream.pipe(res);
}));

export default router;
