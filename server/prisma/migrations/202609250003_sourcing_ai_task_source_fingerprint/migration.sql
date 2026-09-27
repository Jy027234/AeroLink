-- Pin each task to the source state that was authorized at enqueue time.
-- Nullable preserves safe migration of legacy tasks; workers reject null values.
ALTER TABLE "sourcing_ai_tasks"
ADD COLUMN "sourceFingerprint" TEXT;
