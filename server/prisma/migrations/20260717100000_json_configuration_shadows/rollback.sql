-- Manual rollback for P1-04 JSON configuration shadows.
--
-- Run only after application code has been rolled back to a version that no
-- longer reads or dual-writes these fields. The legacy String columns remain
-- untouched throughout this rollback.

ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "scopesJson";
ALTER TABLE "workflow_actions" DROP COLUMN IF EXISTS "payloadJson";
ALTER TABLE "workflow_instances" DROP COLUMN IF EXISTS "contextJson";
ALTER TABLE "webhook_replay_batches" DROP COLUMN IF EXISTS "deliveryIdsJson";
ALTER TABLE "webhook_replay_batches" DROP COLUMN IF EXISTS "filterQueryJson";
ALTER TABLE "webhook_deliveries" DROP COLUMN IF EXISTS "requestHeadersJson";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "filtersJson";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "eventTypesJson";
ALTER TABLE "webhook_endpoints" DROP COLUMN IF EXISTS "customHeadersJson";
