/**
 * Phase 2: DLQ Management Service
 * 
 * 负责管理失败投递的隔离、分类、审核、重试流程
 */

import { Prisma } from '@prisma/client';
import prisma from './prisma.js';

export type FailureReason = '4xx' | '5xx' | 'timeout' | 'connection_error' | 'other';

export interface QuarantineMessage {
  id: string;
  endpointId: string;
  failureReason: FailureReason;
  quarantineAt: Date;
  attemptCount: number;
  lastError: string;
}

export interface DLQStats {
  totalQuarantined: number;
  byAge: {
    lessThan1h: number;
    between1hAnd24h: number;
    moreThan24h: number;
  };
  byFailureReason: Record<FailureReason, number>;
  recoveryRate: number;
}

/**
 * 主要功能:
 * 1. 自动隔离: 失败 N 次后自动进入 DLQ
 * 2. 分类: 按失败原因分类 (HTTP 4xx/5xx/timeout/连接错误)
 * 3. 管理: 查询、审核、重试、放弃 DLQ 消息
 * 4. 监控: 统计 DLQ 年龄分布、恢复率等
 */
export class DLQService {
  /**
   * 检查投递是否应进入 DLQ
   * 规则: attemptCount >= maxRetries 且 status == 'failed'
   */
  async evaluateForQuarantine(deliveryId: string, maxRetries: number = 5): Promise<void> {
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId }
    });

    if (!delivery) {
      console.warn(`Delivery ${deliveryId} not found for DLQ evaluation`);
      return;
    }

    // 如果已达到最大重试次数，移入隔离
    if (delivery.attemptCount >= maxRetries && delivery.status === 'failed') {
      await this.moveToQuarantine(delivery.id, delivery.lastError || 'Max retries exceeded');
    }
  }

  /**
   * 移入隔离 (DLQ)
   */
  async moveToQuarantine(deliveryId: string, reason: string): Promise<void> {
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId }
    });

    if (!delivery) return;

    // 分析失败原因
    const failureReason = this.analyzeFailureReason(delivery.responseStatus, delivery.lastError);

    // 更新投递状态为隔离
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'quarantined',
        quarantineReason: reason,
        quarantineAt: new Date(),
        failureReason
      }
    });

    // 记录失败原因统计 (用于监控)
    await this.recordFailureAnalysis(delivery.endpointId, failureReason);

    console.log(`✉️ Delivery ${deliveryId} moved to DLQ (reason: ${failureReason})`);
  }

  /**
   * 分析失败原因
   */
  private analyzeFailureReason(statusCode: number | null, error: string | null): FailureReason {
    if (!statusCode && !error) return 'other';

    if (statusCode) {
      if (statusCode >= 400 && statusCode < 500) return '4xx';
      if (statusCode >= 500) return '5xx';
    }

    if (error) {
      if (error.includes('timeout') || error.includes('ETIMEDOUT')) return 'timeout';
      if (
        error.includes('ECONNREFUSED') ||
        error.includes('EHOSTUNREACH') ||
        error.includes('connection')
      ) {
        return 'connection_error';
      }
    }

    return 'other';
  }

  /**
   * 记录失败原因统计
   */
  private async recordFailureAnalysis(
    endpointId: string,
    failureReason: FailureReason
  ): Promise<void> {
    const existing = await prisma.webhookFailureAnalysis.findUnique({
      where: {
        endpointId_failureReason: {
          endpointId,
          failureReason
        }
      }
    });

    if (existing) {
      await prisma.webhookFailureAnalysis.update({
        where: {
          endpointId_failureReason: {
            endpointId,
            failureReason
          }
        },
        data: {
          count: existing.count + 1,
          lastOccurrence: new Date()
        }
      });
    } else {
      await prisma.webhookFailureAnalysis.create({
        data: {
          endpointId,
          failureReason,
          count: 1
        }
      });
    }
  }

  /**
   * 查询 DLQ 消息
   */
  async listQuarantined(
    options: {
      limit?: number;
      offset?: number;
      endpointId?: string;
      failureReason?: FailureReason;
    } = {}
  ): Promise<{ deliveries: QuarantineMessage[]; total: number }> {
    const { limit = 20, offset = 0, endpointId, failureReason } = options;

    const where: Prisma.WebhookDeliveryWhereInput = { status: 'quarantined' };
    if (endpointId) where.endpointId = endpointId;
    if (failureReason) where.failureReason = failureReason;

    const [deliveries, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where,
        orderBy: { quarantineAt: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.webhookDelivery.count({ where })
    ]);

    return {
      deliveries: deliveries.map(d => ({
        id: d.id,
        endpointId: d.endpointId,
        failureReason: (d.failureReason || 'other') as FailureReason,
        quarantineAt: d.quarantineAt!,
        attemptCount: d.attemptCount,
        lastError: d.lastError || ''
      })),
      total
    };
  }

  /**
   * 标记 DLQ 消息为已审核
   */
  async markReviewed(
    deliveryId: string,
    reviewedBy: string
  ): Promise<void> {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        dlqReviewedBy: reviewedBy
      }
    });
  }

  /**
   * 重试 DLQ 消息
   */
  async retryQuarantined(
    deliveryId: string,
    options?: {
      resetAttemptCount?: boolean;
      newMaxRetries?: number;
    }
  ): Promise<void> {
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId }
    });

    if (!delivery || delivery.status !== 'quarantined') {
      throw new Error(`Delivery ${deliveryId} is not in quarantine`);
    }

    // 重置为待重试状态
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'pending',
        nextRetryAt: new Date(),
        attemptCount: options?.resetAttemptCount ? 0 : delivery.attemptCount,
        maxRetries: options?.newMaxRetries || delivery.maxRetries,
        quarantineReason: null,
        quarantineAt: null,
        dlqAction: 'RETRY'
      }
    });

    console.log(`🔄 Retrying quarantined delivery ${deliveryId}`);
  }

  /**
   * 放弃 DLQ 消息 (标记为永久失败)
   */
  async abandonQuarantined(deliveryId: string, reason?: string): Promise<void> {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'abandoned',
        dlqAction: 'ABANDON',
        dlqReviewedBy: reason
      }
    });

    console.log(`🚫 Abandoned quarantined delivery ${deliveryId}`);
  }

  /**
   * 获取 DLQ 统计信息
   */
  async getStats(): Promise<DLQStats> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 统计按年龄
    const [lessThan1h, between1hAnd24h, moreThan24h, total] = await Promise.all([
      prisma.webhookDelivery.count({
        where: {
          status: 'quarantined',
          quarantineAt: { gte: oneHourAgo }
        }
      }),
      prisma.webhookDelivery.count({
        where: {
          status: 'quarantined',
          quarantineAt: {
            gte: twentyFourHoursAgo,
            lt: oneHourAgo
          }
        }
      }),
      prisma.webhookDelivery.count({
        where: {
          status: 'quarantined',
          quarantineAt: { lt: twentyFourHoursAgo }
        }
      }),
      prisma.webhookDelivery.count({
        where: { status: 'quarantined' }
      })
    ]);

    // 统计按失败原因
    const reasons = await prisma.webhookFailureAnalysis.findMany();
    const byFailureReason: Record<FailureReason, number> = {
      '4xx': 0,
      '5xx': 0,
      timeout: 0,
      connection_error: 0,
      other: 0
    };

    reasons.forEach(r => {
      byFailureReason[r.failureReason as FailureReason] = r.count;
    });

    // 计算恢复率 (重试成功的 / 总隔离的)
    const recovered = await prisma.webhookDelivery.count({
      where: {
        status: 'delivered',
        dlqAction: 'RETRY'
      }
    });

    const recoveryRate = total > 0 ? Math.round((recovered / total) * 100) : 0;

    return {
      totalQuarantined: total,
      byAge: {
        lessThan1h,
        between1hAnd24h,
        moreThan24h
      },
      byFailureReason,
      recoveryRate
    };
  }

  /**
   * 清理已恢复的 DLQ 消息 (可选的房间清理任务)
   */
  async cleanupRecovered(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

    const result = await prisma.webhookDelivery.deleteMany({
      where: {
        status: 'delivered',
        dlqAction: 'RETRY',
        updatedAt: { lt: cutoffDate }
      }
    });

    console.log(`🧹 Cleaned up ${result.count} recovered DLQ messages older than ${daysOld} days`);
    return result.count;
  }
}

export const dlqService = new DLQService();
