-- P2-07: retain the sanitized request correlation key on asynchronous work.
ALTER TABLE "outbox_events" ADD COLUMN "requestId" TEXT;
CREATE INDEX "outbox_events_requestId_idx" ON "outbox_events"("requestId");
