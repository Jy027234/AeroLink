ALTER TABLE "outbox_events" ADD COLUMN "traceId" TEXT;

CREATE INDEX "outbox_events_traceId_idx" ON "outbox_events"("traceId");
