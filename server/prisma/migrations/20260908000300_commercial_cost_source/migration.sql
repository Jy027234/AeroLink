ALTER TABLE "supplier_quotes" ADD COLUMN "currency" TEXT;
ALTER TABLE "supplier_quotes" ADD COLUMN "currencyReviewStatus" TEXT;

ALTER TABLE "quotations" ADD COLUMN "costSourceType" TEXT;
ALTER TABLE "quotations" ADD COLUMN "costSourceId" TEXT;
ALTER TABLE "quotations" ADD COLUMN "costSourceReason" TEXT;
ALTER TABLE "quotations" ADD COLUMN "costSourceSnapshotJson" TEXT;
ALTER TABLE "quotations" ADD COLUMN "costSourceCapturedAt" TIMESTAMP(3);

CREATE INDEX "quotations_costSourceType_costSourceId_idx"
  ON "quotations"("costSourceType", "costSourceId");
