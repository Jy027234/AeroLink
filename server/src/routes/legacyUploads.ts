import express, { Router } from 'express';
import path from 'node:path';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';
import { canReadStoredObject, contentDisposition } from './files.js';
import { objectStorage } from '../lib/objectStorage.js';
import type { AuthRequest } from '../middleware/auth.js';
import { recordOperationalAlert } from '../lib/alerting.js';

const router = Router();
const legacyStatic = express.static(
  path.resolve(process.env.UPLOADS_DIR || path.resolve(process.cwd(), 'uploads')),
  { fallthrough: true },
);

type LegacyStoredObject = { ownerId: string | null; status: string };
type LegacyUser = { id?: string; role?: string } | undefined;
export type LegacyUploadDecision = 'allow' | 'forbidden' | 'not_found';

/**
 * Preserve old `/uploads/:filename` links without making the directory a
 * generic authenticated static share. New objects are checked against their
 * StoredObject owner; only managers/admins may access an unmigrated legacy
 * file until it has metadata and an owner assigned.
 */
export function getLegacyUploadDecision(
  storedObject: LegacyStoredObject | null,
  user: LegacyUser,
): LegacyUploadDecision {
  const role = user?.role?.toLowerCase();
  const privileged = role === 'admin' || role === 'manager';

  if (!storedObject) return privileged ? 'allow' : 'not_found';
  if (storedObject.status !== 'AVAILABLE') return 'not_found';
  return canReadStoredObject(storedObject, user) ? 'allow' : 'forbidden';
}

function decodeObjectKey(requestPath: string) {
  const raw = requestPath.replace(/^\/+/, '');
  if (!raw) return null;
  try {
    const objectKey = decodeURIComponent(raw);
    const segments = objectKey.split('/');
    if (
      objectKey.includes('\\')
      || segments.some((segment) => segment === '..' || segment === '.')
      || objectKey.startsWith('/')
    ) {
      return null;
    }
    return objectKey;
  } catch {
    return null;
  }
}

router.use(asyncHandler(async (req: AuthRequest, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new AppError('不支持的文件访问方法', 405, 'BAD_REQUEST');
  }

  const objectKey = decodeObjectKey(req.path);
  if (!objectKey) {
    throw new AppError('文件不存在或不可用', 404, 'RESOURCE_NOT_FOUND');
  }

  const storedObject = await prisma.storedObject.findUnique({
    where: { objectKey },
    select: {
      objectKey: true,
      ownerId: true,
      status: true,
      mimeType: true,
      sizeBytes: true,
      originalName: true,
    },
  });
  const decision = getLegacyUploadDecision(storedObject, req.user);
  if (decision === 'not_found') {
    throw new AppError('文件不存在或不可用', 404, 'RESOURCE_NOT_FOUND');
  }
  if (decision === 'forbidden') {
    throw new AppError('无权访问此文件', 403, 'AUTH_FORBIDDEN');
  }

  if (storedObject) {
    let stream;
    try {
      stream = await objectStorage.createReadStream(storedObject.objectKey);
    } catch {
      recordOperationalAlert({
        key: 'object-storage.missing-object',
        severity: 'critical',
        title: 'Legacy object migration gap',
        message: 'A migrated legacy file metadata record points to an unavailable object.',
        source: 'object-storage',
        metadata: { legacyObject: true },
      });
      throw new AppError('文件对象不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    res.setHeader('Content-Type', storedObject.mimeType);
    res.setHeader('Content-Length', String(storedObject.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(storedObject.originalName));
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ message: '文件对象不存在', code: 'RESOURCE_NOT_FOUND' });
      else res.destroy();
    });
    stream.pipe(res);
    return;
  }

  // Authorization is complete at this point; static only resolves the
  // already-authorized unmigrated legacy file and never grants access on its own.
  legacyStatic(req, res, next);
}));

// Kept as a named middleware export so the route catalog treats this
// compatibility surface like the previous static mount rather than inventing
// an OpenAPI operation for an unbounded file path.
export const legacyUploadsMiddleware = router;
export default router;
