ALTER TABLE "supplier_quotes"
ADD COLUMN "revisionOfId" TEXT,
ADD COLUMN "revisionRootId" TEXT,
ADD COLUMN "revisionNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "supersededAt" TIMESTAMP(3),
ADD COLUMN "revisionReason" TEXT;

UPDATE "supplier_quotes"
SET "revisionRootId" = "id";

CREATE UNIQUE INDEX "supplier_quotes_revisionOfId_key"
ON "supplier_quotes"("revisionOfId");

CREATE INDEX "supplier_quotes_revisionRootId_revisionNumber_idx"
ON "supplier_quotes"("revisionRootId", "revisionNumber");

ALTER TABLE "supplier_quotes"
ADD CONSTRAINT "supplier_quotes_revisionOfId_fkey"
FOREIGN KEY ("revisionOfId") REFERENCES "supplier_quotes"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
