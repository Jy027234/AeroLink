-- Trusted server-owned execution records for sourcing AI work. Legacy
-- AgentRuntimeTask records are intentionally not reused for actor ownership.
CREATE TABLE "sourcing_ai_tasks" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "emailId" TEXT NOT NULL,
  "inquiryId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "idempotencyKey" TEXT NOT NULL,
  "draftId" TEXT,
  "errorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sourcing_ai_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sourcing_ai_tasks_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sourcing_ai_tasks_emailId_fkey"
    FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sourcing_ai_tasks_inquiryId_fkey"
    FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sourcing_ai_tasks_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "supplier_quote_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sourcing_ai_tasks_actorId_idempotencyKey_key"
  ON "sourcing_ai_tasks"("actorId", "idempotencyKey");
CREATE INDEX "sourcing_ai_tasks_actorId_createdAt_idx"
  ON "sourcing_ai_tasks"("actorId", "createdAt");
CREATE INDEX "sourcing_ai_tasks_status_updatedAt_idx"
  ON "sourcing_ai_tasks"("status", "updatedAt");
