-- P1-01: RFQ / quotation / order state governance.
-- Adds optimistic versions, a shared immutable status history table, and a
-- one-time backfill for the state that existed before this migration.

ALTER TABLE "rfqs" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quotations" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "orders" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Historical RFQ records used UI aliases. Normalize them before the initial
-- history snapshot so all subsequent state-machine checks see canonical values.
UPDATE "rfqs"
SET "status" = CASE UPPER(TRIM("status"))
  WHEN 'PENDING' THEN 'PENDING'
  WHEN 'SOURCING' THEN 'SOURCING'
  WHEN 'QUOTING' THEN 'QUOTING'
  WHEN 'APPROVING' THEN 'APPROVING'
  WHEN 'APPROVED' THEN 'APPROVING'
  WHEN 'ORDERED' THEN 'ORDERED'
  WHEN 'SENT' THEN 'ORDERED'
  WHEN 'COMPLETED' THEN 'COMPLETED'
  WHEN 'WON' THEN 'COMPLETED'
  WHEN 'CANCELLED' THEN 'CANCELLED'
  WHEN 'CANCELED' THEN 'CANCELLED'
  WHEN 'LOST' THEN 'CANCELLED'
  ELSE "status"
END
WHERE UPPER(TRIM("status")) IN (
  'PENDING', 'SOURCING', 'QUOTING', 'APPROVING', 'APPROVED', 'ORDERED',
  'SENT', 'COMPLETED', 'WON', 'CANCELLED', 'CANCELED', 'LOST'
);

CREATE TABLE "transaction_status_history" (
  "id" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "reason" TEXT,
  "actorId" TEXT,
  "version" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transaction_status_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transaction_status_history_entityType_entityId_createdAt_idx"
  ON "transaction_status_history"("entityType", "entityId", "createdAt");
CREATE INDEX "transaction_status_history_actorId_createdAt_idx"
  ON "transaction_status_history"("actorId", "createdAt");

ALTER TABLE "transaction_status_history"
  ADD CONSTRAINT "transaction_status_history_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "transaction_status_history" (
  "id", "entityType", "entityId", "fromStatus", "toStatus", "reasonCode",
  "reason", "actorId", "version", "createdAt"
)
SELECT
  'backfill-rfq-' || r."id",
  'RFQ',
  r."id",
  NULL,
  r."status",
  'MIGRATED_INITIAL_STATE',
  'Backfilled from the state that existed before P1-01 governance.',
  u."id",
  r."version",
  r."createdAt"
FROM "rfqs" r
LEFT JOIN "users" u ON u."id" = r."createdBy"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "transaction_status_history" (
  "id", "entityType", "entityId", "fromStatus", "toStatus", "reasonCode",
  "reason", "actorId", "version", "createdAt"
)
SELECT
  'backfill-quotation-' || q."id",
  'QUOTATION',
  q."id",
  NULL,
  q."status",
  'MIGRATED_INITIAL_STATE',
  'Backfilled from the state that existed before P1-01 governance.',
  u."id",
  q."version",
  q."createdAt"
FROM "quotations" q
LEFT JOIN "users" u ON u."id" = q."createdBy"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "transaction_status_history" (
  "id", "entityType", "entityId", "fromStatus", "toStatus", "reasonCode",
  "reason", "actorId", "version", "createdAt"
)
SELECT
  'backfill-order-' || o."id",
  'ORDER',
  o."id",
  NULL,
  o."status",
  'MIGRATED_INITIAL_STATE',
  'Backfilled from the state that existed before P1-01 governance.',
  NULL,
  o."version",
  o."createdAt"
FROM "orders" o
ON CONFLICT ("id") DO NOTHING;
