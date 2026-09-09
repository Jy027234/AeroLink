import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';
import { objectStorage } from '../lib/objectStorage.js';
import { AuthRequest } from '../middleware/auth.js';
import { recordOperationalAlert } from '../lib/alerting.js';
import { hasCapability, type CapabilityActor } from '../lib/capabilityPolicy.js';
import { assertCanReadReceiptEvidence, assertCanReadDirectShipmentEvidence, canReadPurchaseEvidence } from '../modules/procurementSettlement/index.js';

const router = Router();

export function canReadStoredObject(
  storedObject: { ownerId: string | null; domain?: string | null },
  user: { id?: string; role?: string } | undefined,
) {
  // Commercial documents require current order scope and cost access, even
  // for their uploader or a manager using an old /uploads link.
  if (['purchase_commitment', 'stock_receipt', 'supplier_direct_shipment'].includes(storedObject.domain ?? '')) return false;
  const role = user?.role?.toLowerCase();
  const privileged = role === 'admin' || role === 'manager';
  return privileged || Boolean(user?.id && storedObject.ownerId === user.id);
}

type DownloadStoredObject = {
  id: string;
  ownerId: string | null;
  domain: string | null;
  resourceId: string | null;
  version: number;
  sha256: string;
  status: string;
};

/**
 * Resolve the authorization policy for the current download path. Dedicated
 * business domains must be checked before the generic owner/operator policy;
 * otherwise an uploaded owner or admin could bypass the receipt evidence ACL.
 */
export async function canReadStoredObjectDownload(
  tx: Prisma.TransactionClient,
  storedObject: DownloadStoredObject,
  user: CapabilityActor | undefined,
): Promise<boolean> {
  if (storedObject.domain === 'supplier_direct_shipment') {
    if (!user) return false;
    try { await assertCanReadDirectShipmentEvidence(tx, user, storedObject.id); return true; }
    catch (error) {
      if (error instanceof AppError && error.code === 'AUTH_FORBIDDEN') return false;
      throw error;
    }
  }
  if (storedObject.domain === 'purchase_commitment') {
    return canReadPurchaseEvidence(tx, storedObject, user);
  }
  if (storedObject.domain === 'stock_receipt') {
    try {
      await assertCanReadReceiptEvidence(tx, storedObject, user);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'AUTH_FORBIDDEN') return false;
      throw error;
    }
  }
  return canReadStoredObject(storedObject, user) || await canReadReturnEvidence(storedObject, user);
}

export function contentDisposition(filename?: string | null) {
  const fallback = (filename || 'download').replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename || fallback);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Independent quality staff may inspect the exact evidence received with a return. */
export async function canReadReturnEvidence(
  object: { id: string; ownerId: string | null; domain: string | null; resourceId: string | null; version: number; sha256: string; status: string },
  user: CapabilityActor | undefined,
) {
  if (!user || !hasCapability(user, 'quality_review', 'read')
    || !['order', 'orders'].includes(object.domain ?? '') || !object.resourceId || object.status !== 'AVAILABLE') return false;
  const hold = await prisma.returnHold.findFirst({
    where: {
      evidence: { array_contains: [{ id: object.id, version: object.version, sha256: object.sha256, status: object.status }] },
      shipmentLine: { shipment: { orderId: object.resourceId } },
    },
    select: { shipmentLine: { select: { shipment: { select: { order: { select: {
      quotation: { select: { createdBy: true, creator: { select: { department: true } } } },
    } } } } } } },
  });
  if (!hold) return false;
  const quotation = hold.shipmentLine.shipment.order.quotation;
  return hasCapability(user, 'order', 'read', { ownerId: quotation.createdBy, department: quotation.creator.department });
}

router.get('/:id', asyncHandler(async (req: AuthRequest, res) => {
  const storedObject = await prisma.storedObject.findUnique({ where: { id: req.params.id } });
  if (!storedObject || storedObject.status !== 'AVAILABLE') {
    throw new AppError('文件不存在或不可用', 404, 'RESOURCE_NOT_FOUND');
  }
  const allowed = await canReadStoredObjectDownload(prisma, storedObject, req.user);
  if (!allowed) {
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
