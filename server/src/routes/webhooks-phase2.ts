/**
 * Phase 2 Webhook API Routes
 * 
 * 新增端点:
 * - DLQ 管理
 * - 高级过滤订阅
 * - 批量重放
 */

import { Router, Response } from 'express';
import { dlqService, type FailureReason } from '../lib/dlqService.js';
import { filterEngine, validateFilterConfig, type FilterConfig } from '../lib/filterEngine.js';
import { bulkReplayService } from '../lib/bulkReplayService.js';
import prisma from '../lib/prisma.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { requireCapability } from '../middleware/capability.js';
import { webhookAudit } from '../middleware/webhookAudit.js';
import * as z from 'zod';

const router = Router();

function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

// ─────────────────────────────────────────────────────────────
// DLQ Management Endpoints
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/webhooks/phase2/dlq
 * 查看 DLQ 消息列表
 */
router.get(
  '/dlq',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const endpointId = req.query.endpointId as string | undefined;
      const failureReason = req.query.failureReason as FailureReason | undefined;

      const result = await dlqService.listQuarantined({
        limit,
        offset,
        endpointId,
        failureReason
      });

      res.json({
        data: result.deliveries,
        pagination: {
          limit,
          offset,
          total: result.total
        }
      });
    } catch (error) {
      console.error('Error fetching DLQ:', error);
      res.status(500).json({ error: 'Failed to fetch DLQ messages' });
    }
  }
);

/**
 * GET /api/webhooks/phase2/dlq/stats
 * 获取 DLQ 统计信息
 */
router.get(
  '/dlq/stats',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const stats = await dlqService.getStats();
      res.json(stats);
    } catch (error) {
      console.error('Error fetching DLQ stats:', error);
      res.status(500).json({ error: 'Failed to fetch DLQ statistics' });
    }
  }
);

/**
 * POST /api/webhooks/phase2/dlq/:id/review
 * 标记 DLQ 消息为已审核
 */
router.post(
  '/dlq/:id/review',
  authenticate,
  requireCapability('webhook', 'manage'),
  webhookAudit('REVIEW', 'dlq_message'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      await dlqService.markReviewed(id, req.user?.id || 'unknown');
      res.json({ message: 'Marked as reviewed' });
    } catch (error) {
      console.error('Error marking DLQ as reviewed:', error);
      res.status(500).json({ error: 'Failed to mark as reviewed' });
    }
  }
);

/**
 * POST /api/webhooks/phase2/dlq/:id/retry
 * 重试 DLQ 消息
 */
router.post(
  '/dlq/:id/retry',
  authenticate,
  requireCapability('webhook', 'manage'),
  webhookAudit('RETRY', 'dlq_message'),
  validateBody(
    z.object({
      resetAttemptCount: z.boolean().optional(),
      newMaxRetries: z.number().optional()
    })
  ),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { resetAttemptCount, newMaxRetries } = req.body || {};

      await dlqService.retryQuarantined(id, {
        resetAttemptCount,
        newMaxRetries
      });

      res.json({ message: 'DLQ message queued for retry' });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Error retrying DLQ message:', error);
      res.status(message?.includes('not in quarantine') ? 400 : 500).json({
        error: message || 'Failed to retry DLQ message'
      });
    }
  }
);

/**
 * POST /api/webhooks/phase2/dlq/:id/abandon
 * 放弃 DLQ 消息
 */
router.post(
  '/dlq/:id/abandon',
  authenticate,
  requireCapability('webhook', 'manage'),
  webhookAudit('ABANDON', 'dlq_message'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { reason } = req.body || {};

      await dlqService.abandonQuarantined(id, reason);
      res.json({ message: 'DLQ message abandoned' });
    } catch (error) {
      console.error('Error abandoning DLQ message:', error);
      res.status(500).json({ error: 'Failed to abandon DLQ message' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Advanced Filter Testing
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/phase2/subscriptions/test-filter
 * 测试过滤规则
 */
router.post(
  '/subscriptions/test-filter',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { filter, payload } = req.body;

      // 验证过滤配置
      const errors = validateFilterConfig(filter as FilterConfig);
      if (errors.length > 0) {
        return res.status(400).json({
          error: 'Invalid filter configuration',
          details: errors
        });
      }

      // 评估 payload
      const matches = filterEngine.evaluate(filter as FilterConfig, payload);

      res.json({
        matches,
        filter,
        payload
      });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Error testing filter:', error);
      res.status(500).json({ error: message || 'Failed to test filter' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Bulk Replay Endpoints
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/phase2/replay/query
 * 查询可重放的投递
 */
router.post(
  '/replay/query',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { startDate, endDate, eventTypes, endpointIds, status, limit } = req.body;

      const deliveries = await bulkReplayService.query({
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        eventTypes,
        endpointIds,
        status: status || 'delivered',
        limit: Math.min(limit || 1000, 5000)
      });

      res.json({
        count: deliveries.length,
        deliveries
      });
    } catch (error) {
      console.error('Error querying deliveries for replay:', error);
      res.status(500).json({ error: 'Failed to query deliveries' });
    }
  }
);

/**
 * POST /api/webhooks/phase2/replay/estimate
 * 预估重放影响范围
 */
router.post(
  '/replay/estimate',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { deliveryIds } = req.body;

      if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) {
        return res.status(400).json({ error: 'deliveryIds must be a non-empty array' });
      }

      const estimate = await bulkReplayService.estimate(deliveryIds);
      res.json(estimate);
    } catch (error) {
      console.error('Error estimating replay impact:', error);
      res.status(500).json({ error: 'Failed to estimate replay impact' });
    }
  }
);

/**
 * POST /api/webhooks/phase2/replay/execute
 * 执行批量重放
 */
router.post(
  '/replay/execute',
  authenticate,
  requireCapability('webhook', 'manage'),
  webhookAudit('REPLAY', 'delivery', () => 'bulk'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { deliveryIds, concurrency, overridePayload } = req.body;

      if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) {
        return res.status(400).json({ error: 'deliveryIds must be a non-empty array' });
      }

      if (deliveryIds.length > 10000) {
        return res.status(400).json({
          error: 'Too many deliveries (max 10000)',
          count: deliveryIds.length
        });
      }

      const result = await bulkReplayService.replay(deliveryIds, {
        concurrency: Math.min(concurrency || 3, 10),
        overridePayload,
        triggeredBy: req.user?.id || 'unknown'
      });

      res.json({
        message: 'Replay batch created',
        ...result
      });
    } catch (error) {
      console.error('Error executing replay:', error);
      res.status(500).json({ error: 'Failed to execute replay' });
    }
  }
);

/**
 * GET /api/webhooks/phase2/replay/:batchId
 * 查看重放批次进度
 */
router.get(
  '/replay/:batchId',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { batchId } = req.params;
      const progress = await bulkReplayService.getProgress(batchId);
      res.json(progress);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Error fetching replay progress:', error);
      if (message?.includes('not found')) {
        return res.status(404).json({ error: 'Batch not found' });
      }
      res.status(500).json({ error: 'Failed to fetch replay progress' });
    }
  }
);

/**
 * GET /api/webhooks/phase2/replay
 * 查看所有重放批次
 */
router.get(
  '/replay',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const status = req.query.status as string | undefined;

      const result = await bulkReplayService.listBatches({
        limit,
        offset,
        status
      });

      res.json({
        data: result.batches,
        pagination: {
          limit,
          offset,
          total: result.total
        }
      });
    } catch (error) {
      console.error('Error fetching replay batches:', error);
      res.status(500).json({ error: 'Failed to fetch replay batches' });
    }
  }
);

/**
 * POST /api/webhooks/phase2/replay/:batchId/cancel
 * 取消重放批次
 */
router.post(
  '/replay/:batchId/cancel',
  authenticate,
  requireCapability('webhook', 'manage'),
  webhookAudit('CANCEL_REPLAY', 'delivery', (req) => req.params.batchId),
  async (req: AuthRequest, res: Response) => {
    try {
      const { batchId } = req.params;
      await bulkReplayService.cancelBatch(batchId);
      res.json({ message: 'Replay batch cancelled' });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Error cancelling replay batch:', error);
      if (message?.includes('not in progress')) {
        return res.status(400).json({ error: message });
      }
      res.status(500).json({ error: 'Failed to cancel replay batch' });
    }
  }
);

router.get(
  '/audit',
  authenticate,
  requireCapability('webhook', 'read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const action = req.query.action as string | undefined;
      const resourceType = req.query.resourceType as string | undefined;

      const where = {
        ...(action ? { action } : {}),
        ...(resourceType ? { resourceType } : {}),
      };

      const [data, total] = await Promise.all([
        prisma.webhookAuditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.webhookAuditLog.count({ where }),
      ]);

      res.json({
        data,
        pagination: { limit, offset, total },
      });
    } catch (error) {
      console.error('Error fetching phase2 audit logs:', error);
      res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
  }
);

export default router;
