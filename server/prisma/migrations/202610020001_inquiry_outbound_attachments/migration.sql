-- Inquiry uploads are scoped to one inquiry. Outbound rows freeze the exact
-- immutable StoredObject metadata selected during human confirmation.
CREATE TABLE "inquiry_attachments" (
  "id" TEXT NOT NULL,
  "inquiryId" TEXT NOT NULL,
  "storedObjectId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inquiry_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inquiry_attachments_inquiryId_fkey"
    FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "inquiry_attachments_storedObjectId_fkey"
    FOREIGN KEY ("storedObjectId") REFERENCES "stored_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "inquiry_attachments_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "inquiry_attachments_storedObjectId_key"
  ON "inquiry_attachments"("storedObjectId");
CREATE INDEX "inquiry_attachments_inquiryId_createdAt_idx"
  ON "inquiry_attachments"("inquiryId", "createdAt");
CREATE INDEX "inquiry_attachments_createdById_createdAt_idx"
  ON "inquiry_attachments"("createdById", "createdAt");

CREATE TABLE "outbound_inquiry_email_attachments" (
  "id" TEXT NOT NULL,
  "outboundEmailId" TEXT NOT NULL,
  "inquiryAttachmentId" TEXT NOT NULL,
  "storedObjectId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "position" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbound_inquiry_email_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbound_inquiry_email_attachments_outboundEmailId_fkey"
    FOREIGN KEY ("outboundEmailId") REFERENCES "outbound_emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "outbound_inquiry_email_attachments_inquiryAttachmentId_fkey"
    FOREIGN KEY ("inquiryAttachmentId") REFERENCES "inquiry_attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "outbound_inquiry_email_attachments_storedObjectId_fkey"
    FOREIGN KEY ("storedObjectId") REFERENCES "stored_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "outbound_inquiry_email_attachments_outboundEmailId_inquiryAttachmentId_key"
  ON "outbound_inquiry_email_attachments"("outboundEmailId", "inquiryAttachmentId");
CREATE INDEX "outbound_inquiry_email_attachments_outboundEmailId_position_idx"
  ON "outbound_inquiry_email_attachments"("outboundEmailId", "position");
CREATE INDEX "outbound_inquiry_email_attachments_storedObjectId_idx"
  ON "outbound_inquiry_email_attachments"("storedObjectId");
