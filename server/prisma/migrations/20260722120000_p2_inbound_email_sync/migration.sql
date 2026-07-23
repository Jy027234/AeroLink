-- P2 inbound email reliability: provider identity, durable mailbox cursor,
-- retry state and worker lease. Existing seed/manual emails remain valid
-- because all provider identity columns are nullable.

ALTER TABLE "emails" ADD COLUMN "messageId" TEXT;
ALTER TABLE "emails" ADD COLUMN "mailbox" TEXT NOT NULL DEFAULT 'INBOX';
ALTER TABLE "emails" ADD COLUMN "imapUid" INTEGER;
ALTER TABLE "emails" ADD COLUMN "imapUidValidity" TEXT;
ALTER TABLE "emails" ADD COLUMN "rawHeaders" TEXT;
ALTER TABLE "emails" ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "emails" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "emails" ADD COLUMN "discardedAt" TIMESTAMP(3);

UPDATE "emails"
SET "processingStatus" = 'PROCESSED',
    "processedAt" = COALESCE("processedAt", "receivedAt")
WHERE EXISTS (
  SELECT 1 FROM "rfqs" WHERE "rfqs"."emailId" = "emails"."id"
);

CREATE UNIQUE INDEX "emails_accountId_messageId_key"
  ON "emails"("accountId", "messageId");
CREATE UNIQUE INDEX "emails_accountId_mailbox_imapUidValidity_imapUid_key"
  ON "emails"("accountId", "mailbox", "imapUidValidity", "imapUid");
CREATE INDEX "emails_processingStatus_receivedAt_idx"
  ON "emails"("processingStatus", "receivedAt");
CREATE INDEX "emails_accountId_receivedAt_idx"
  ON "emails"("accountId", "receivedAt");

CREATE TABLE "email_sync_cursors" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "mailbox" TEXT NOT NULL DEFAULT 'INBOX',
  "uidValidity" TEXT,
  "lastUid" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'IDLE',
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "nextSyncAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lockedAt" TIMESTAMP(3),
  "workerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "email_sync_cursors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_sync_cursors_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "email_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "email_sync_cursors_accountId_mailbox_key"
  ON "email_sync_cursors"("accountId", "mailbox");
CREATE INDEX "email_sync_cursors_status_nextSyncAt_idx"
  ON "email_sync_cursors"("status", "nextSyncAt");
CREATE INDEX "email_sync_cursors_workerId_status_idx"
  ON "email_sync_cursors"("workerId", "status");
