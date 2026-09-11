ALTER TABLE "generated_documents"
  ADD COLUMN "contentSha256" TEXT,
  ADD COLUMN "snapshotHash" TEXT,
  ADD COLUMN "pdfBytes" BYTEA,
  ADD COLUMN "pdfSha256" TEXT;

CREATE UNIQUE INDEX "generated_documents_quotation_pdf_key"
  ON "generated_documents"("quotationId") WHERE "documentType" = 'QUOTATION_PDF';
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_document_pdf_integrity_fields"
  CHECK (("pdfBytes" IS NULL AND "pdfSha256" IS NULL)
    OR ("pdfBytes" IS NOT NULL AND "pdfSha256" IS NOT NULL AND "snapshotHash" IS NOT NULL));

CREATE FUNCTION protect_frozen_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."snapshotHash" IS NOT NULL THEN
    IF ROW(NEW."contentHtml", NEW."payloadJson", NEW."snapshotHash", NEW."contentSha256", NEW."title", NEW."documentType",
      NEW."quotationId", NEW."orderId", NEW."customerId", NEW."templateId", NEW."generatedAt", NEW."generatedById")
      IS DISTINCT FROM ROW(OLD."contentHtml", OLD."payloadJson", OLD."snapshotHash", OLD."contentSha256", OLD."title", OLD."documentType",
      OLD."quotationId", OLD."orderId", OLD."customerId", OLD."templateId", OLD."generatedAt", OLD."generatedById") THEN
      RAISE EXCEPTION 'Frozen document content cannot be replaced';
    END IF;
    IF OLD."pdfBytes" IS NOT NULL AND ROW(NEW."pdfBytes", NEW."pdfSha256") IS DISTINCT FROM ROW(OLD."pdfBytes", OLD."pdfSha256") THEN
      RAISE EXCEPTION 'Frozen document PDF bytes cannot be replaced';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER generated_documents_protect_frozen BEFORE UPDATE ON "generated_documents"
  FOR EACH ROW EXECUTE FUNCTION protect_frozen_document();
