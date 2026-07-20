ALTER TABLE "outbox_events" ADD COLUMN "workerId" TEXT;

CREATE INDEX "outbox_events_workerId_status_idx" ON "outbox_events"("workerId", "status");

ALTER TABLE "webhook_deliveries" ADD COLUMN "workerId" TEXT;

CREATE INDEX "webhook_deliveries_workerId_status_idx" ON "webhook_deliveries"("workerId", "status");
