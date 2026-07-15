-- P1-02: generic Idempotency-Key records and transactional outbox.
--
-- These tables are intentionally storage-only: actor IDs are not foreign keys
-- so an archived/deleted account never prevents retry history from being read.
-- Payloads and cached responses are JSON text to remain compatible with the
-- supported PostgreSQL runtime and the SQLite migration/import tooling.

CREATE TABLE "idempotency_records" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "responseStatus" INTEGER,
  "responseBody" TEXT,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_actorId_scope_idempotencyKey_key"
  ON "idempotency_records"("actorId", "scope", "idempotencyKey");
CREATE INDEX "idempotency_records_status_expiresAt_idx"
  ON "idempotency_records"("status", "expiresAt");
CREATE INDEX "idempotency_records_actorId_createdAt_idx"
  ON "idempotency_records"("actorId", "createdAt");

CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextRetryAt" TIMESTAMP(3),
  "lockedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_events_status_nextRetryAt_createdAt_idx"
  ON "outbox_events"("status", "nextRetryAt", "createdAt");
CREATE INDEX "outbox_events_aggregateType_aggregateId_createdAt_idx"
  ON "outbox_events"("aggregateType", "aggregateId", "createdAt");
CREATE INDEX "outbox_events_createdById_createdAt_idx"
  ON "outbox_events"("createdById", "createdAt");

-- A nullable link is only populated for Outbox-originated deliveries. Existing
-- manual webhook retries retain NULL and therefore keep their current behavior.
ALTER TABLE "webhook_deliveries" ADD COLUMN "outboxEventId" TEXT;
CREATE UNIQUE INDEX "webhook_deliveries_endpointId_outboxEventId_key"
  ON "webhook_deliveries"("endpointId", "outboxEventId");
