-- P2-05: keep webhook lease timestamps separate from general update timestamps.
ALTER TABLE "webhook_deliveries" ADD COLUMN "lockedAt" TIMESTAMP(3);
CREATE INDEX "webhook_deliveries_status_lockedAt_idx" ON "webhook_deliveries"("status", "lockedAt");
