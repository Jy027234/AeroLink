ALTER TABLE "quotations" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE "approvals" ADD COLUMN "requiredLevel" TEXT;
ALTER TABLE "approvals" ADD COLUMN "policyVersion" TEXT;
ALTER TABLE "approvals" ADD COLUMN "reviewedVersion" INTEGER;
ALTER TABLE "approvals" ADD COLUMN "snapshotJson" TEXT;
