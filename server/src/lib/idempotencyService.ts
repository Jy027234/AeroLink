import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import { isUniqueConstraintError } from './prismaErrors.js';
import prisma from './prisma.js';

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_RESPONSE_BYTES = 1024 * 1024;

export type IdempotencyContext = {
  actorId: string;
  scope: string;
  key?: string;
  requestHash: string;
};

export type IdempotentOperationResult<T> = {
  payload: T;
  statusCode?: number;
  resourceType?: string;
  resourceId?: string;
};

export type IdempotentExecution<T> = {
  payload: T;
  statusCode: number;
  replayed: boolean;
  key?: string;
};

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value);
  }

  return value;
}

function hashRequest(value: unknown) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function readIdempotencyKey(req: Request): string | undefined {
  const rawKey = req.get(IDEMPOTENCY_KEY_HEADER);
  if (rawKey === undefined) {
    return undefined;
  }

  const key = rawKey.trim();
  const hasControlCharacter = Array.from(key).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
  if (!key || key.length > 255 || hasControlCharacter) {
    throw new AppError('Idempotency-Key 必须是 1 到 255 个可打印字符', 400, 'BAD_REQUEST');
  }

  return key;
}

/**
 * Builds a deterministic context from the authenticated caller, endpoint scope
 * and request content. The header remains optional during the compatibility
 * period; supported clients send it automatically.
 */
export function buildIdempotencyContext(req: Request, actorId: string, scope: string): IdempotencyContext {
  const key = readIdempotencyKey(req);
  return {
    actorId,
    scope,
    key,
    requestHash: hashRequest({
      path: req.path,
      params: req.params,
      query: req.query,
      body: req.body,
    }),
  };
}

function toCachedResponse(payload: unknown) {
  const responseBody = JSON.stringify(payload);
  if (Buffer.byteLength(responseBody, 'utf8') > MAX_CACHED_RESPONSE_BYTES) {
    throw new AppError('幂等响应超过可缓存大小限制', 500, 'INTERNAL_ERROR');
  }
  return responseBody;
}

async function replayExistingOperation<T>(context: Required<Pick<IdempotencyContext, 'actorId' | 'scope' | 'key' | 'requestHash'>>): Promise<IdempotentExecution<T>> {
  const existing = await prisma.idempotencyRecord.findFirst({
    where: {
      actorId: context.actorId,
      scope: context.scope,
      idempotencyKey: context.key,
    },
  });

  if (!existing) {
    throw new AppError('幂等请求仍在竞争中，请使用相同 Idempotency-Key 重试', 409, 'IDEMPOTENCY_IN_PROGRESS');
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    const removed = await prisma.idempotencyRecord.deleteMany({
      where: {
        id: existing.id,
        expiresAt: { lte: new Date() },
      },
    });
    if (removed.count === 1) {
      throw new ExpiredIdempotencyRecordError();
    }
  }

  if (existing.requestHash !== context.requestHash) {
    throw new AppError('同一个 Idempotency-Key 不能用于不同请求', 409, 'IDEMPOTENCY_KEY_REUSED');
  }

  if (existing.status !== 'COMPLETED' || !existing.responseBody || !existing.responseStatus) {
    throw new AppError('相同 Idempotency-Key 的请求仍在处理中，请稍后重试', 409, 'IDEMPOTENCY_IN_PROGRESS');
  }

  try {
    return {
      payload: JSON.parse(existing.responseBody) as T,
      statusCode: existing.responseStatus,
      replayed: true,
      key: context.key,
    };
  } catch {
    throw new AppError('幂等请求缓存损坏，请使用新的 Idempotency-Key 重试', 500, 'INTERNAL_ERROR');
  }
}

class ExpiredIdempotencyRecordError extends Error {}

/**
 * Marks the one expected unique-key conflict: inserting the idempotency
 * record itself. Business operations can also legitimately raise P2002, and
 * those errors must not be mistaken for a request replay.
 */
class IdempotencyKeyConflictError extends Error {}

/**
 * Runs a business mutation and its idempotency record in one transaction.
 * The supplied operation must also enqueue every external side effect through
 * the transactional outbox using the same transaction client.
 */
export async function runIdempotentOperation<T>(
  context: IdempotencyContext,
  operation: (tx: Prisma.TransactionClient) => Promise<IdempotentOperationResult<T>>,
): Promise<IdempotentExecution<T>> {
  if (!context.key) {
    const operationResult = await prisma.$transaction(operation);
    return {
      payload: operationResult.payload,
      statusCode: operationResult.statusCode ?? 200,
      replayed: false,
    };
  }

  const keyedContext = context as Required<Pick<IdempotencyContext, 'actorId' | 'scope' | 'key' | 'requestHash'>>;

  try {
    const execution = await prisma.$transaction(async (tx) => {
      let record: { id: string };
      try {
        record = await tx.idempotencyRecord.create({
          data: {
            actorId: keyedContext.actorId,
            scope: keyedContext.scope,
            idempotencyKey: keyedContext.key,
            requestHash: keyedContext.requestHash,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new IdempotencyKeyConflictError();
        }
        throw error;
      }

      const operationResult = await operation(tx);
      await tx.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: 'COMPLETED',
          responseStatus: operationResult.statusCode ?? 200,
          responseBody: toCachedResponse(operationResult.payload),
          resourceType: operationResult.resourceType,
          resourceId: operationResult.resourceId,
        },
      });

      return {
        payload: operationResult.payload,
        statusCode: operationResult.statusCode ?? 200,
        replayed: false,
        key: keyedContext.key,
      };
    });

    return execution;
  } catch (error) {
    if (!(error instanceof IdempotencyKeyConflictError)) {
      throw error;
    }

    try {
      return await replayExistingOperation<T>(keyedContext);
    } catch (replayError) {
      if (replayError instanceof ExpiredIdempotencyRecordError) {
        return runIdempotentOperation(context, operation);
      }
      throw replayError;
    }
  }
}

export function applyIdempotencyHeaders(res: Response, execution: Pick<IdempotentExecution<unknown>, 'key' | 'replayed'>) {
  if (execution.key) {
    res.setHeader(IDEMPOTENCY_KEY_HEADER, execution.key);
  }
  if (execution.replayed) {
    res.setHeader('Idempotency-Replayed', 'true');
  }
}

/** Housekeeping for the 24-hour replay window; PROCESSING records are retained for investigation. */
export async function pruneExpiredIdempotencyRecords() {
  const result = await prisma.idempotencyRecord.deleteMany({
    where: {
      expiresAt: { lte: new Date() },
      status: { not: 'PROCESSING' },
    },
  });
  return result.count;
}
