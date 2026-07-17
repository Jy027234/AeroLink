import prisma from './prisma.js';
import { emitWebhookEvent } from './webhookService.js';
import { buildJsonArrayShadow, buildJsonObjectShadow } from './jsonConfigurationShadows.js';

export interface ReplayQuery {
	startDate?: Date;
	endDate?: Date;
	eventTypes?: string[];
	endpointIds?: string[];
	status?: 'delivered' | 'failed' | 'pending' | 'quarantined';
	limit?: number;
}

export interface ReplayEstimate {
	totalDeliveries: number;
	affectedEndpoints: string[];
	estimatedDuration: number;
	estimatedTimestamp: Date;
}

export interface ReplayBatchProgress {
	batchId: string;
	status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
	totalDeliveries: number;
	succeeded: number;
	failed: number;
	pending: number;
	progress: number;
	startedAt?: Date;
	completedAt?: Date;
	errorMessage?: string;
}

type DeliverySummary = {
	id: string;
	eventType: string;
	endpointId: string;
	payload: string;
	status: string;
	deliveredAt: Date | null;
};

export class BulkReplayService {
	async query(queryParams: ReplayQuery): Promise<DeliverySummary[]> {
		const { startDate, endDate, eventTypes, endpointIds, status, limit = 1000 } = queryParams;
		const where: Record<string, unknown> = {};

		if (status) {
			where.status = status;
		}

		if (startDate || endDate) {
			where.createdAt = {
				...(startDate ? { gte: startDate } : {}),
				...(endDate ? { lte: endDate } : {}),
			};
		}

		if (eventTypes?.length) {
			where.eventType = { in: eventTypes };
		}

		if (endpointIds?.length) {
			where.endpointId = { in: endpointIds };
		}

		return prisma.webhookDelivery.findMany({
			where,
			orderBy: { createdAt: 'desc' },
			take: limit,
			select: {
				id: true,
				eventType: true,
				endpointId: true,
				payload: true,
				status: true,
				deliveredAt: true,
			},
		});
	}

	async estimate(deliveryIds: string[]): Promise<ReplayEstimate> {
		const deliveries = await prisma.webhookDelivery.findMany({
			where: { id: { in: deliveryIds } },
			select: { endpointId: true },
		});

		const affectedEndpoints = [...new Set(deliveries.map((d) => d.endpointId))];

		return {
			totalDeliveries: deliveryIds.length,
			affectedEndpoints,
			estimatedDuration: Math.ceil(deliveryIds.length * 0.5),
			estimatedTimestamp: new Date(),
		};
	}

	async replay(
		deliveryIds: string[],
		options?: {
			concurrency?: number;
			overridePayload?: Record<string, unknown>;
			triggeredBy?: string;
		}
	): Promise<{ batchId: string }> {
		const { concurrency = 3, overridePayload, triggeredBy = 'MANUAL' } = options ?? {};
		const filterQuery = buildJsonObjectShadow({ source: 'manual_replay' });
		const replayDeliveryIds = buildJsonArrayShadow(deliveryIds);

		const batch = await prisma.webhookReplayBatch.create({
			data: {
				triggeredBy,
				filterQuery: filterQuery.legacy,
				filterQueryJson: filterQuery.shadow,
				deliveryIds: replayDeliveryIds.legacy,
				deliveryIdsJson: replayDeliveryIds.shadow,
				totalDeliveries: deliveryIds.length,
				pending: deliveryIds.length,
				status: 'IN_PROGRESS',
				startedAt: new Date(),
			},
		});

		void this.executeReplayAsync(batch.id, deliveryIds, concurrency, overridePayload);
		return { batchId: batch.id };
	}

	private async executeReplayAsync(
		batchId: string,
		deliveryIds: string[],
		concurrency: number,
		overridePayload?: Record<string, unknown>
	): Promise<void> {
		try {
			let succeeded = 0;
			let failed = 0;

			for (let i = 0; i < deliveryIds.length; i += concurrency) {
				const batch = await prisma.webhookReplayBatch.findUnique({
					where: { id: batchId },
					select: { status: true },
				});
				if (!batch || batch.status !== 'IN_PROGRESS') {
					return;
				}
				const group = deliveryIds.slice(i, i + concurrency);
				const results = await Promise.allSettled(
					group.map((id) => this.replayDelivery(id, overridePayload))
				);

				for (const result of results) {
					if (result.status === 'fulfilled' && result.value) {
						succeeded += 1;
					} else {
						failed += 1;
					}
				}

				await prisma.webhookReplayBatch.update({
					where: { id: batchId },
					data: {
						succeeded,
						failed,
						pending: Math.max(deliveryIds.length - succeeded - failed, 0),
					},
				});
			}

			const batch = await prisma.webhookReplayBatch.findUnique({
				where: { id: batchId },
				select: { status: true },
			});
			if (!batch || batch.status !== 'IN_PROGRESS') {
				return;
			}

			await prisma.webhookReplayBatch.update({
				where: { id: batchId },
				data: {
					status: 'COMPLETED',
					completedAt: new Date(),
				},
			});
		} catch (error) {
			await prisma.webhookReplayBatch.update({
				where: { id: batchId },
				data: {
					status: 'FAILED',
					errorMessage: String(error),
					completedAt: new Date(),
				},
			});
		}
	}

	private async replayDelivery(
		deliveryId: string,
		overridePayload?: Record<string, unknown>
	): Promise<boolean> {
		try {
			const delivery = await prisma.webhookDelivery.findUnique({
				where: { id: deliveryId },
			});

			if (!delivery) {
				return false;
			}

			let payload: Record<string, unknown> = JSON.parse(delivery.payload);
			if (overridePayload) {
				payload = { ...payload, ...overridePayload };
			}

			await emitWebhookEvent(delivery.eventType, payload);
			return true;
		} catch {
			return false;
		}
	}

	async getProgress(batchId: string): Promise<ReplayBatchProgress> {
		const batch = await prisma.webhookReplayBatch.findUnique({ where: { id: batchId } });
		if (!batch) {
			throw new Error('Batch not found');
		}

		const progress = batch.totalDeliveries > 0
			? Math.round(((batch.succeeded + batch.failed) / batch.totalDeliveries) * 100)
			: 0;

		return {
			batchId: batch.id,
			status: batch.status as ReplayBatchProgress['status'],
			totalDeliveries: batch.totalDeliveries,
			succeeded: batch.succeeded,
			failed: batch.failed,
			pending: batch.pending,
			progress,
			startedAt: batch.startedAt ?? undefined,
			completedAt: batch.completedAt ?? undefined,
			errorMessage: batch.errorMessage ?? undefined,
		};
	}

	async listBatches(options: {
		limit?: number;
		offset?: number;
		status?: string;
	} = {}): Promise<{ batches: ReplayBatchProgress[]; total: number }> {
		const { limit = 20, offset = 0, status } = options;
		const where = status ? { status } : {};

		const [batches, total] = await Promise.all([
			prisma.webhookReplayBatch.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				take: limit,
				skip: offset,
			}),
			prisma.webhookReplayBatch.count({ where }),
		]);

		return {
			batches: batches.map((b) => ({
				batchId: b.id,
				status: b.status as ReplayBatchProgress['status'],
				totalDeliveries: b.totalDeliveries,
				succeeded: b.succeeded,
				failed: b.failed,
				pending: b.pending,
				progress: b.totalDeliveries > 0
					? Math.round(((b.succeeded + b.failed) / b.totalDeliveries) * 100)
					: 0,
				startedAt: b.startedAt ?? undefined,
				completedAt: b.completedAt ?? undefined,
				errorMessage: b.errorMessage ?? undefined,
			})),
			total,
		};
	}

	async cancelBatch(batchId: string): Promise<void> {
		const batch = await prisma.webhookReplayBatch.findUnique({ where: { id: batchId } });
		if (!batch) {
			throw new Error('Batch not found');
		}

		if (batch.status !== 'IN_PROGRESS') {
			throw new Error('Batch is not in progress');
		}

		await prisma.webhookReplayBatch.update({
			where: { id: batchId },
			data: {
				status: 'FAILED',
				errorMessage: 'Cancelled by user',
				completedAt: new Date(),
			},
		});
	}
}

export const bulkReplayService = new BulkReplayService();
