ALTER TABLE "quotations"
  ADD COLUMN "commercialRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "revisionOfId" TEXT,
  ADD COLUMN "revisionRootId" TEXT,
  ADD COLUMN "revisionReason" TEXT,
  ADD COLUMN "supersededAt" TIMESTAMP(3);

ALTER TABLE "quotations" ADD CONSTRAINT "quotations_revisionOfId_fkey"
  FOREIGN KEY ("revisionOfId") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_commercial_revision_check"
  CHECK ("commercialRevision" >= 1 AND (("revisionOfId" IS NULL AND "commercialRevision" = 1)
    OR ("revisionOfId" IS NOT NULL AND "commercialRevision" > 1 AND "revisionRootId" IS NOT NULL
      AND "revisionReason" IS NOT NULL AND length(trim("revisionReason")) > 0)));
CREATE UNIQUE INDEX "quotations_revisionOfId_key" ON "quotations"("revisionOfId");
CREATE INDEX "quotations_revisionRootId_commercialRevision_idx" ON "quotations"("revisionRootId", "commercialRevision");
