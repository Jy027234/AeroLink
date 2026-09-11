import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import {
  getReturnReleaseContext,
  receiveShipmentReturn,
  releaseShipmentReturn,
} from './returnService.js';

vi.mock('../../lib/outboxService.js', () => ({
  enqueueBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

const receiveActor: CapabilityActor = { id: 'inventory-1', role: 'manager', department: 'sales' };
const releaseActor: CapabilityActor = { id: 'admin-1', role: 'admin', department: null };
const qualityActor: CapabilityActor = { id: 'quality-1', role: 'quality_manager', department: null };

function fixture(holdId = 'return-hold-1') {
  const detail: any = {
    id: 'detail-1',
    inventoryItemId: 'item-1',
    quantity: 0,
    allocatedQuantity: 0,
    status: 'AVAILABLE',
    serialNumber: null,
    batchNumber: 'B-1',
    conditionCode: 'NE',
    warehouse: 'WH-1',
    location: 'A-01',
    certificateType: 'NONE',
    certificateNumber: null,
    certificateFileUrl: null,
    lifeLimited: false,
    remainingHours: null,
    remainingCycles: null,
    shelfLifeDate: null,
    shelfLifeDays: null,
    nextOverhaulDue: null,
    storageCondition: 'DRY',
    updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    inventoryItem: {
      id: 'item-1',
      partNumber: 'PN-1',
      trackingType: 'BATCH',
      updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    },
    certificates: [],
  };
  const order: any = {
    id: 'order-1',
    quotationId: 'quotation-1',
    quotation: {
      id: 'quotation-1',
      createdBy: 'sales-1',
      creator: { id: 'sales-1', department: 'sales' },
      certificateRequired: false,
      certificateType: null,
      rfq: { certificateRequired: false, certificateType: null },
    },
  };
  const identitySnapshot = {
    inventoryDetailId: detail.id,
    inventoryItemId: detail.inventoryItemId,
    partNumber: detail.inventoryItem.partNumber,
    trackingType: detail.inventoryItem.trackingType,
    serialNumber: detail.serialNumber,
    batchNumber: detail.batchNumber,
    conditionCode: detail.conditionCode,
    warehouse: detail.warehouse,
    location: detail.location,
  };
  const outbound: any = {
    id: 'outbound-1',
    inventoryDetailId: detail.id,
    type: 'OUTBOUND',
    quantity: -1,
    orderId: order.id,
    assignmentId: 'assignment-1',
    inventoryDetail: detail,
  };
  const line: any = {
    id: 'shipment-line-1',
    shipmentId: 'shipment-1',
    orderLineId: 'order-line-1',
    assignmentId: 'assignment-1',
    outboundTransactionId: outbound.id,
    quantity: 1,
    receivedQuantity: 0,
    returnedQuantity: 0,
    version: 1,
    identitySnapshot,
    shipment: { id: 'shipment-1', orderId: order.id, createdById: 'shipper-1', order },
    orderLine: { id: 'order-line-1', orderId: order.id, order },
    assignment: { id: 'assignment-1', orderLineId: 'order-line-1', createdById: 'allocator-1' },
    outboundTransaction: outbound,
  };
  const state: { hold: any | null; transactionCount: number } = { hold: null, transactionCount: 0 };
  const file = {
    id: 'return-file-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE', ownerId: receiveActor.id,
    domain: 'orders', resourceId: order.id,
  };
  const releaseFile = { ...file, id: 'release-file-1', ownerId: releaseActor.id };
  const txMock: any = {
    returnHold: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.commandId) return state.hold?.commandId === where.commandId ? state.hold : null;
        if (where.id) {
          return state.hold ? { ...state.hold, shipmentLine: line, inventoryDetail: detail } : null;
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.releaseCommandId) return state.hold?.releaseCommandId === where.releaseCommandId ? state.hold : null;
        if (where.inventoryDetailId && where.status) {
          if (state.hold?.inventoryDetailId === where.inventoryDetailId && state.hold.status !== 'RELEASED') return state.hold;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        if (where.status === 'RELEASED' && state.hold?.status === 'RELEASED') {
          return [{ ...state.hold, shipmentLine: line }];
        }
        return [];
      }),
      create: vi.fn(async ({ data }: any) => {
        state.hold = { id: holdId, ...data };
        return state.hold;
      }),
      updateMany: vi.fn(async ({ data }: any) => {
        if (!state.hold) return { count: 0 };
        state.hold = {
          ...state.hold,
          ...data,
          version: state.hold.version + (data.version?.increment ?? 0),
          status: data.status ?? state.hold.status,
          returnTransactionId: data.returnTransactionId ?? state.hold.returnTransactionId,
        };
        return { count: 1 };
      }),
    },
    returnEvent: {
      create: vi.fn(async ({ data }: any) => ({ id: `return-event-${data.kind}`, ...data })),
    },
    shipmentLine: {
      findUnique: vi.fn(async () => line),
      updateMany: vi.fn(async ({ data }: any) => {
        line.returnedQuantity += data.returnedQuantity.increment;
        line.version += data.version.increment;
        return { count: 1 };
      }),
    },
    inventoryDetail: {
      findUnique: vi.fn(async () => detail),
      updateMany: vi.fn(async ({ data }: any) => {
        detail.quantity += data.quantity.increment;
        detail.status = data.status;
        detail.updatedAt = new Date('2026-09-09T00:01:00.000Z');
        return { count: 1 };
      }),
    },
    inventoryTransaction: {
      findFirst: vi.fn(async () => ({ id: outbound.id })),
      findMany: vi.fn(async () => [{ id: outbound.id, quantity: -1 }]),
      create: vi.fn(async ({ data }: any) => {
        state.transactionCount += 1;
        return { id: `return-transaction-${state.transactionCount}`, ...data };
      }),
    },
    storedObject: { findMany: vi.fn(async ({ where }: any) =>
      [file, releaseFile].filter(row => where.id.in.includes(row.id))), updateMany: vi.fn(async () => ({ count: 1 })) },
    certificate: { findMany: vi.fn(async () => []) },
  };
  return { tx: txMock as Prisma.TransactionClient, detail, line, order, state, file };
}

function receiveInput(tx: Prisma.TransactionClient, actor = receiveActor) {
  return {
    tx,
    actor,
    shipmentLineId: 'shipment-line-1',
    quantity: 1,
    evidenceIds: ['return-file-1'],
    verifiedSerialNumber: '',
    verifiedBatchNumber: 'B-1',
    reason: '客户拒收后退回待检',
    commandId: 'return-receive-1',
  };
}

describe('D13 return service', () => {
  it('receives into a quarantine hold without changing saleable inventory', async () => {
    const f = fixture();
    const result = await receiveShipmentReturn(receiveInput(f.tx));

    expect(result.replayed).toBe(false);
    expect(result.status).toBe('QUARANTINED');
    expect(result.quantity).toBe(1);
    expect(f.detail.quantity).toBe(0);
    expect(f.tx.inventoryDetail.updateMany).not.toHaveBeenCalled();
    expect(f.tx.returnEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'RECEIVED', quantity: 1 }),
    }));
  });

  it('replays the same receive command and rejects a changed request', async () => {
    const f = fixture();
    const input = receiveInput(f.tx);
    const first = await receiveShipmentReturn(input);
    const replay = await receiveShipmentReturn(input);
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    await expect(receiveShipmentReturn({ ...input, quantity: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('releases only after snapshot, identity, evidence, and quality checks, then writes RETURN', async () => {
    const f = fixture();
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id });
    expect(context.snapshotHash).not.toBe(received.snapshotHash);
    expect(context.returnHoldId).toBe(received.id);
    const result = await releaseShipmentReturn({
      tx: f.tx,
      actor: releaseActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '质量复核通过，恢复可售库存',
      commandId: 'return-release-1',
    });

    expect(result.replayed).toBe(false);
    expect(result.status).toBe('RELEASED');
    expect(result.returnTransactionId).toBe('return-transaction-1');
    expect(result.releasedAt).toBeInstanceOf(Date);
    expect(result.releaseReason).toBe('质量复核通过，恢复可售库存');
    expect(f.detail.quantity).toBe(1);
    expect(f.tx.returnEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'RELEASED', quantity: 1 }),
    }));
  });

  it('lets an authorized quality reviewer inspect receiver-owned evidence but requires reviewer-owned release evidence', async () => {
    const f = fixture();
    const qualityFile = {
      id: 'quality-file-1', version: 1, sha256: 'b'.repeat(64), status: 'AVAILABLE', ownerId: qualityActor.id,
      domain: 'orders', resourceId: 'order-1',
    };
    (f.tx.storedObject as any).findMany.mockImplementation(async ({ where }: any) =>
      where.id.in.includes(qualityFile.id) ? [qualityFile] : [f.file]);
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: qualityActor, returnHoldId: received.id });
    const result = await releaseShipmentReturn({
      tx: f.tx,
      actor: qualityActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: [qualityFile.id],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '质量人员独立复核通过',
      commandId: 'return-release-quality-1',
    });
    expect(result.status).toBe('RELEASED');
  });

  it('requires every release check explicitly instead of accepting an empty checks object', async () => {
    const f = fixture();
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id });

    await expect(releaseShipmentReturn({
      tx: f.tx,
      actor: releaseActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: {} as any,
      reason: '质量核对项不完整',
      commandId: 'return-release-missing-checks-1',
    })).rejects.toMatchObject({ code: 'QUALITY_REVIEW_BLOCKED' });
  });

  it('fails closed when the identity changes and never lets the receiver self approve, including admin', async () => {
    const f = fixture();
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    f.detail.conditionCode = 'AR';
    await expect(getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id }))
      .rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });

    const own = fixture();
    own.file.ownerId = releaseActor.id;
    const adminReceive = await receiveShipmentReturn(receiveInput(own.tx, releaseActor)) as any;
    const ownContext = await getReturnReleaseContext({ tx: own.tx, actor: releaseActor, returnHoldId: adminReceive.id });
    await expect(releaseShipmentReturn({
      tx: own.tx,
      actor: releaseActor,
      returnHoldId: adminReceive.id,
      snapshotHash: ownContext.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '不能自批',
      commandId: 'return-release-self-1',
    })).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
  });

  it('keeps an existing saleable batch allocation while adding a released return quantity', async () => {
    const f = fixture();
    f.detail.quantity = 2;
    f.detail.allocatedQuantity = 1;
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id });
    const result = await releaseShipmentReturn({
      tx: f.tx,
      actor: releaseActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '批次退货质量复核通过',
      commandId: 'return-release-batch-allocated-1',
    });

    expect(result.status).toBe('RELEASED');
    expect(f.detail.quantity).toBe(3);
    expect(f.detail.allocatedQuantity).toBe(1);
    expect(f.tx.inventoryDetail.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ allocatedQuantity: 1 }),
    }));
  });

  it('rejects merging a return into an existing quarantined quantity', async () => {
    const f = fixture();
    f.detail.status = 'QUARANTINED';
    f.detail.quantity = 1;
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id });

    await expect(releaseShipmentReturn({
      tx: f.tx,
      actor: releaseActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '不得合并旧隔离库存',
      commandId: 'return-release-quarantined-existing-1',
    })).rejects.toMatchObject({ code: 'QUALITY_REVIEW_BLOCKED' });
    expect(f.tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(f.tx.inventoryDetail.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['stale serial quantity', 1, 0],
    ['stale serial allocation', 0, 1],
  ])('rejects a serial return when %s remains on the detail', async (_label, quantity, allocatedQuantity) => {
    const f = fixture();
    f.detail.inventoryItem.trackingType = 'SERIAL';
    f.detail.serialNumber = 'SN-1';
    f.detail.batchNumber = null;
    f.detail.quantity = quantity;
    f.detail.allocatedQuantity = allocatedQuantity;
    f.line.identitySnapshot = {
      ...f.line.identitySnapshot,
      trackingType: 'SERIAL',
      serialNumber: 'SN-1',
      batchNumber: null,
    };
    const input = { ...receiveInput(f.tx), verifiedSerialNumber: 'SN-1', verifiedBatchNumber: '' };
    const received = await receiveShipmentReturn(input) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id });

    await expect(releaseShipmentReturn({
      tx: f.tx,
      actor: releaseActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: 'SN-1',
      verifiedBatchNumber: '',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '序号件存在未清理旧库存事实',
      commandId: `return-release-serial-stale-${quantity}-${allocatedQuantity}`,
    })).rejects.toMatchObject({ code: 'QUALITY_REVIEW_BLOCKED' });
    expect(f.tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('does not require a certificate from an unflagged certificate type', async () => {
    const f = fixture();
    f.order.certificateType = 'AAC-038';
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id });

    const result = await releaseShipmentReturn({
      tx: f.tx,
      actor: releaseActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '未要求证书的类型字段不应强制证书',
      commandId: 'return-release-unflagged-certificate-type-1',
    });
    expect(result.status).toBe('RELEASED');
  });

  it('requires a certificate when the physical detail declares a certificate type', async () => {
    const f = fixture();
    f.detail.certificateType = 'AAC-038';
    const received = await receiveShipmentReturn(receiveInput(f.tx)) as any;
    const context = await getReturnReleaseContext({ tx: f.tx, actor: releaseActor, returnHoldId: received.id });

    await expect(releaseShipmentReturn({
      tx: f.tx,
      actor: releaseActor,
      returnHoldId: received.id,
      snapshotHash: context.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '实物声明证书类型但没有匹配证书',
      commandId: 'return-release-declared-certificate-type-1',
    })).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_REQUIRED' });
  });

  it('binds the current snapshot to the exact return hold and rejects another hold hash', async () => {
    const first = fixture('return-hold-first');
    const second = fixture('return-hold-second');
    const firstReceived = await receiveShipmentReturn(receiveInput(first.tx)) as any;
    const secondReceived = await receiveShipmentReturn(receiveInput(second.tx)) as any;
    const firstContext = await getReturnReleaseContext({ tx: first.tx, actor: releaseActor, returnHoldId: firstReceived.id });
    const secondContext = await getReturnReleaseContext({ tx: second.tx, actor: releaseActor, returnHoldId: secondReceived.id });

    expect(firstContext.snapshotHash).not.toBe(secondContext.snapshotHash);
    await expect(releaseShipmentReturn({
      tx: first.tx,
      actor: releaseActor,
      returnHoldId: firstReceived.id,
      snapshotHash: secondContext.snapshotHash,
      evidenceIds: ['release-file-1'],
      verifiedSerialNumber: '',
      verifiedBatchNumber: 'B-1',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: '跨退货隔离记录复用快照应拒绝',
      commandId: 'return-release-cross-hold-hash-1',
    })).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
  });
});
