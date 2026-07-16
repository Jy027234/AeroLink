-- P1-04 third slice: JSONB shadows for existing JSON-string configuration.
-- Legacy String columns remain the compatibility representation until a later
-- read-cutover is explicitly approved.

ALTER TABLE "webhook_endpoints"
  ADD COLUMN "customHeadersJson" JSONB;

ALTER TABLE "webhook_subscriptions"
  ADD COLUMN "eventTypesJson" JSONB,
  ADD COLUMN "filtersJson" JSONB;

ALTER TABLE "webhook_deliveries"
  ADD COLUMN "requestHeadersJson" JSONB;

ALTER TABLE "webhook_replay_batches"
  ADD COLUMN "filterQueryJson" JSONB,
  ADD COLUMN "deliveryIdsJson" JSONB;

ALTER TABLE "workflow_instances"
  ADD COLUMN "contextJson" JSONB;

ALTER TABLE "workflow_actions"
  ADD COLUMN "payloadJson" JSONB;

ALTER TABLE "api_keys"
  ADD COLUMN "scopesJson" JSONB;

-- Casting deliberately fails on malformed legacy JSON, allowing the
-- migration transaction to roll back rather than losing configuration data.
UPDATE "webhook_endpoints"
SET "customHeadersJson" = "customHeaders"::jsonb;

UPDATE "webhook_subscriptions"
SET
  "eventTypesJson" = "eventTypes"::jsonb,
  "filtersJson" = "filters"::jsonb;

UPDATE "webhook_deliveries"
SET "requestHeadersJson" = "requestHeaders"::jsonb;

UPDATE "webhook_replay_batches"
SET
  "filterQueryJson" = "filterQuery"::jsonb,
  "deliveryIdsJson" = "deliveryIds"::jsonb;

UPDATE "workflow_instances"
SET "contextJson" = "context"::jsonb;

UPDATE "workflow_actions"
SET "payloadJson" = "payload"::jsonb;

UPDATE "api_keys"
SET "scopesJson" = "scopes"::jsonb;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "webhook_endpoints" WHERE "customHeadersJson" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill webhook endpoint JSON shadows';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_subscriptions" WHERE "eventTypesJson" IS NULL OR "filtersJson" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill webhook subscription JSON shadows';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_deliveries" WHERE "requestHeadersJson" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill webhook delivery JSON shadows';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_replay_batches" WHERE "filterQueryJson" IS NULL OR "deliveryIdsJson" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill webhook replay JSON shadows';
  END IF;
  IF EXISTS (SELECT 1 FROM "workflow_instances" WHERE "contextJson" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill workflow instance JSON shadows';
  END IF;
  IF EXISTS (SELECT 1 FROM "workflow_actions" WHERE "payloadJson" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill workflow action JSON shadows';
  END IF;
  IF EXISTS (SELECT 1 FROM "api_keys" WHERE "scopesJson" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill API key JSON shadows';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_endpoints" WHERE jsonb_typeof("customHeadersJson") <> 'object') THEN
    RAISE EXCEPTION 'Webhook endpoint customHeaders must be JSON objects';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_subscriptions" WHERE jsonb_typeof("eventTypesJson") <> 'array' OR jsonb_typeof("filtersJson") <> 'object') THEN
    RAISE EXCEPTION 'Webhook subscription JSON shapes are invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_deliveries" WHERE jsonb_typeof("requestHeadersJson") <> 'object') THEN
    RAISE EXCEPTION 'Webhook delivery requestHeaders must be JSON objects';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_replay_batches" WHERE jsonb_typeof("filterQueryJson") <> 'object' OR jsonb_typeof("deliveryIdsJson") <> 'array') THEN
    RAISE EXCEPTION 'Webhook replay JSON shapes are invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM "workflow_instances" WHERE jsonb_typeof("contextJson") <> 'object') THEN
    RAISE EXCEPTION 'Workflow instance context must be a JSON object';
  END IF;
  IF EXISTS (SELECT 1 FROM "workflow_actions" WHERE jsonb_typeof("payloadJson") <> 'object') THEN
    RAISE EXCEPTION 'Workflow action payload must be a JSON object';
  END IF;
  IF EXISTS (SELECT 1 FROM "api_keys" WHERE jsonb_typeof("scopesJson") <> 'array') THEN
    RAISE EXCEPTION 'API key scopes must be a JSON array';
  END IF;
END $$;
