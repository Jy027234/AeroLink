-- P2-06: durable file metadata separated from object bytes.
CREATE TABLE "stored_objects" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalName" TEXT,
    "domain" TEXT,
    "resourceId" TEXT,
    "ownerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "retentionUntil" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stored_objects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stored_objects_objectKey_key" ON "stored_objects"("objectKey");
CREATE INDEX "stored_objects_domain_resourceId_idx" ON "stored_objects"("domain", "resourceId");
CREATE INDEX "stored_objects_ownerId_createdAt_idx" ON "stored_objects"("ownerId", "createdAt");
CREATE INDEX "stored_objects_status_retentionUntil_idx" ON "stored_objects"("status", "retentionUntil");
