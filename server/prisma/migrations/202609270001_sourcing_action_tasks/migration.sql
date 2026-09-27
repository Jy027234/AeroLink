-- Server-owned task snapshots for bounded human-confirmed sourcing actions.
CREATE TABLE "sourcing_action_tasks" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetInquiryId" TEXT,
  "targetSupplierQuoteId" TEXT,
  "targetVersion" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "contentSnapshotJson" TEXT,
  "requestId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING_HUMAN',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "confirmedById" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "retriedById" TEXT,
  "retryHistoryJson" TEXT NOT NULL DEFAULT '[]',
  "cancelledById" TEXT,
  "outboundEmailId" TEXT,
  "resultJson" TEXT,
  "errorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sourcing_action_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sourcing_action_tasks_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sourcing_action_tasks_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "sourcing_action_tasks_retriedById_fkey"
    FOREIGN KEY ("retriedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "sourcing_action_tasks_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "sourcing_action_tasks_targetInquiryId_fkey"
    FOREIGN KEY ("targetInquiryId") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sourcing_action_tasks_targetSupplierQuoteId_fkey"
    FOREIGN KEY ("targetSupplierQuoteId") REFERENCES "supplier_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sourcing_action_tasks_outboundEmailId_fkey"
    FOREIGN KEY ("outboundEmailId") REFERENCES "outbound_emails"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sourcing_action_tasks_requestId_key"
  ON "sourcing_action_tasks"("requestId");
CREATE UNIQUE INDEX "sourcing_action_tasks_outboundEmailId_key"
  ON "sourcing_action_tasks"("outboundEmailId");
CREATE UNIQUE INDEX "sourcing_action_tasks_actorId_idempotencyKey_key"
  ON "sourcing_action_tasks"("actorId", "idempotencyKey");
CREATE INDEX "sourcing_action_tasks_actorId_createdAt_idx"
  ON "sourcing_action_tasks"("actorId", "createdAt");
CREATE INDEX "sourcing_action_tasks_status_updatedAt_idx"
  ON "sourcing_action_tasks"("status", "updatedAt");
CREATE INDEX "sourcing_action_tasks_targetType_targetId_createdAt_idx"
  ON "sourcing_action_tasks"("targetType", "targetId", "createdAt");
