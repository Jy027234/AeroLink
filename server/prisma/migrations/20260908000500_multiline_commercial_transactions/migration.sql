ALTER TABLE "rfqs" ADD COLUMN "lineItemsMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "quotations" ADD COLUMN "lineItemsMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "lineItemsMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "rfq_lines" ADD COLUMN "ataChapter" TEXT, ADD COLUMN "aircraftType" TEXT, ADD COLUMN "aircraftModel" TEXT;
ALTER TABLE "quotation_lines"
  ADD COLUMN "costSourceType" TEXT,
  ADD COLUMN "costSourceId" TEXT,
  ADD COLUMN "costSourceReason" TEXT,
  ADD COLUMN "costSourceSnapshotJson" TEXT,
  ADD COLUMN "costSourceCapturedAt" TIMESTAMP(3);

-- Existing single-line commands keep their one-order invariant. Explicit
-- line-item quotations may generate separate orders for partial acceptance.
DROP INDEX "orders_quotationId_key";
CREATE INDEX "orders_quotationId_idx" ON "orders"("quotationId");
CREATE UNIQUE INDEX "orders_legacy_quotation_key" ON "orders"("quotationId") WHERE "lineItemsMode" = false;
