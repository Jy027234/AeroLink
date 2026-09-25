-- Persist inbound reply threading, explicit inquiry links, original attachment
-- objects and versioned supplier quote drafts.

ALTER TABLE "emails" ADD COLUMN "inReplyTo" TEXT;
ALTER TABLE "emails" ADD COLUMN "references" TEXT;
ALTER TABLE "emails" ADD COLUMN "threadMatchStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "emails" ADD COLUMN "threadMatchReason" TEXT;
ALTER TABLE "emails" ADD COLUMN "attachmentStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "emails" ADD COLUMN "attachmentError" TEXT;

CREATE INDEX "emails_threadMatchStatus_receivedAt_idx"
  ON "emails"("threadMatchStatus", "receivedAt");
CREATE INDEX "outbound_emails_providerMessageId_idx"
  ON "outbound_emails"("providerMessageId");

CREATE TABLE "inquiry_email_links" (
  "id" TEXT NOT NULL,
  "emailId" TEXT NOT NULL,
  "inquiryId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "manualReason" TEXT,
  "confirmationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "confirmedAt" TIMESTAMP(3),
  "confirmedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inquiry_email_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inquiry_email_links_emailId_fkey"
    FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inquiry_email_links_inquiryId_fkey"
    FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inquiry_email_links_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "inquiry_email_links_emailId_inquiryId_key"
  ON "inquiry_email_links"("emailId", "inquiryId");
CREATE INDEX "inquiry_email_links_inquiryId_confirmationStatus_createdAt_idx"
  ON "inquiry_email_links"("inquiryId", "confirmationStatus", "createdAt");
CREATE INDEX "inquiry_email_links_emailId_confirmationStatus_idx"
  ON "inquiry_email_links"("emailId", "confirmationStatus");

CREATE TABLE "email_attachments" (
  "id" TEXT NOT NULL,
  "emailId" TEXT NOT NULL,
  "storedObjectId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "contentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_attachments_emailId_fkey"
    FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "email_attachments_storedObjectId_fkey"
    FOREIGN KEY ("storedObjectId") REFERENCES "stored_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "email_attachments_emailId_createdAt_idx"
  ON "email_attachments"("emailId", "createdAt");
CREATE INDEX "email_attachments_storedObjectId_idx"
  ON "email_attachments"("storedObjectId");

CREATE TABLE "supplier_quote_drafts" (
  "id" TEXT NOT NULL,
  "emailId" TEXT NOT NULL,
  "inquiryId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "payloadJson" TEXT NOT NULL,
  "aiProvider" TEXT,
  "aiModel" TEXT,
  "aiPromptVersion" TEXT,
  "aiConfidence" DOUBLE PRECISION,
  "aiMetadataJson" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "confirmedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_quote_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_quote_drafts_emailId_fkey"
    FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_quote_drafts_inquiryId_fkey"
    FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_quote_drafts_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_quote_drafts_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "supplier_quote_drafts_emailId_inquiryId_version_key"
  ON "supplier_quote_drafts"("emailId", "inquiryId", "version");
CREATE INDEX "supplier_quote_drafts_inquiryId_status_updatedAt_idx"
  ON "supplier_quote_drafts"("inquiryId", "status", "updatedAt");
CREATE INDEX "supplier_quote_drafts_supplierId_status_updatedAt_idx"
  ON "supplier_quote_drafts"("supplierId", "status", "updatedAt");

ALTER TABLE "supplier_quotes" ADD COLUMN "sourceDraftId" TEXT;
ALTER TABLE "supplier_quotes" ADD COLUMN "sourceDraftItemKey" TEXT;
ALTER TABLE "supplier_quotes"
  ADD CONSTRAINT "supplier_quotes_sourceDraftId_fkey"
  FOREIGN KEY ("sourceDraftId") REFERENCES "supplier_quote_drafts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "supplier_quotes_sourceDraftId_sourceDraftItemKey_key"
  ON "supplier_quotes"("sourceDraftId", "sourceDraftItemKey");
