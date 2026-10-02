-- Link inquiry sends to the existing outbound email delivery lifecycle.
ALTER TABLE "outbound_emails" ADD COLUMN "inquiryId" TEXT;

CREATE INDEX "outbound_emails_inquiryId_purpose_createdAt_idx"
  ON "outbound_emails"("inquiryId", "purpose", "createdAt");

ALTER TABLE "outbound_emails"
  ADD CONSTRAINT "outbound_emails_inquiryId_fkey"
  FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
