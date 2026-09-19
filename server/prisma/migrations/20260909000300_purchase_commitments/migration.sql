-- D14 procurement commitment foundation.
-- This migration stores a purchase commitment as a historical commercial
-- snapshot. Receipt, direct-ship, payment, and ledger facts are intentionally
-- left to later migrations.

CREATE TYPE "PurchaseCommitmentStatus" AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'CONFIRMED',
  'CLOSED',
  'REJECTED',
  'CANCELLED'
);

CREATE TYPE "PurchaseCommitmentFulfillmentMode" AS ENUM (
  'STOCK_RECEIPT',
  'SUPPLIER_DIRECT'
);

CREATE TABLE "purchase_commitments" (
  "id" TEXT NOT NULL,
  "commitmentNumber" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "totalCost" DECIMAL(18,4) NOT NULL,
  "status" "PurchaseCommitmentStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT NOT NULL,
  "submittedById" TEXT,
  "submittedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "approvalLevel" TEXT,
  "approvalPolicyVersion" TEXT,
  "approvalSnapshot" JSONB,
  "confirmedById" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "supplierReferenceNo" TEXT,
  "confirmationEvidence" JSONB,
  "paymentTerms" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "purchase_commitments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_commitment_lines" (
  "id" TEXT NOT NULL,
  "purchaseCommitmentId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "sourceSupplierQuoteId" TEXT,
  "partNumber" TEXT NOT NULL,
  "uom" TEXT NOT NULL DEFAULT 'EA',
  "quantity" INTEGER NOT NULL,
  "cancelledQuantity" INTEGER NOT NULL DEFAULT 0,
  "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
  "directShippedQuantity" INTEGER NOT NULL DEFAULT 0,
  "unitCost" DECIMAL(18,4) NOT NULL,
  "lineTotal" DECIMAL(18,4) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "promisedDate" TIMESTAMP(3) NOT NULL,
  "fulfillmentMode" "PurchaseCommitmentFulfillmentMode" NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "identitySnapshot" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_commitment_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_commitment_events" (
  "id" TEXT NOT NULL,
  "purchaseCommitmentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "eventNo" INTEGER NOT NULL,
  "requestHash" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_commitment_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_commitments_commitmentNumber_key"
  ON "purchase_commitments"("commitmentNumber");
CREATE INDEX "purchase_commitments_orderId_status_idx"
  ON "purchase_commitments"("orderId", "status");
CREATE INDEX "purchase_commitments_supplierId_status_idx"
  ON "purchase_commitments"("supplierId", "status");

CREATE UNIQUE INDEX "purchase_commitment_lines_purchaseCommitmentId_lineNo_key"
  ON "purchase_commitment_lines"("purchaseCommitmentId", "lineNo");
CREATE UNIQUE INDEX "purchase_commitment_lines_purchaseCommitmentId_orderLineId_key"
  ON "purchase_commitment_lines"("purchaseCommitmentId", "orderLineId");
CREATE INDEX "purchase_commitment_lines_orderLineId_idx"
  ON "purchase_commitment_lines"("orderLineId");
CREATE INDEX "purchase_commitment_lines_sourceSupplierQuoteId_idx"
  ON "purchase_commitment_lines"("sourceSupplierQuoteId");

CREATE UNIQUE INDEX "purchase_commitment_events_commandId_eventNo_key"
  ON "purchase_commitment_events"("commandId", "eventNo");
CREATE INDEX "purchase_commitment_events_purchaseCommitmentId_eventNo_idx"
  ON "purchase_commitment_events"("purchaseCommitmentId", "eventNo");
CREATE INDEX "purchase_commitment_events_actorId_createdAt_idx"
  ON "purchase_commitment_events"("actorId", "createdAt");

ALTER TABLE "purchase_commitments"
  ADD CONSTRAINT "purchase_commitments_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitments_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitments_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitments_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitments_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitments_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_commitment_lines"
  ADD CONSTRAINT "purchase_commitment_lines_purchaseCommitmentId_fkey"
    FOREIGN KEY ("purchaseCommitmentId") REFERENCES "purchase_commitments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitment_lines_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitment_lines_sourceSupplierQuoteId_fkey"
    FOREIGN KEY ("sourceSupplierQuoteId") REFERENCES "supplier_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_commitment_events"
  ADD CONSTRAINT "purchase_commitment_events_purchaseCommitmentId_fkey"
    FOREIGN KEY ("purchaseCommitmentId") REFERENCES "purchase_commitments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_commitment_events_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_commitments"
  ADD CONSTRAINT "purchase_commitments_currency_total_version_check"
  CHECK ("currency" = 'USD' AND "totalCost" >= 0 AND "version" > 0
    AND length(btrim("commitmentNumber")) > 0);

ALTER TABLE "purchase_commitment_lines"
  ADD CONSTRAINT "purchase_commitment_lines_business_values_check"
  CHECK ("lineNo" > 0 AND length(btrim("partNumber")) > 0
    AND length(btrim("uom")) > 0 AND "quantity" > 0
    AND "cancelledQuantity" >= 0 AND "receivedQuantity" >= 0
    AND "directShippedQuantity" = 0
    AND ("cancelledQuantity"::BIGINT + "receivedQuantity"::BIGINT
      + "directShippedQuantity"::BIGINT) <= "quantity"
    AND "unitCost" >= 0 AND "lineTotal" >= 0
    AND "lineTotal" = ("unitCost" * "quantity")
    AND "currency" = 'USD' AND "version" > 0);

ALTER TABLE "purchase_commitment_events"
  ADD CONSTRAINT "purchase_commitment_events_business_values_check"
  CHECK (length(btrim("kind")) > 0 AND length(btrim("actorId")) > 0
    AND length(btrim("commandId")) > 0 AND "eventNo" > 0
    AND length(btrim("requestHash")) > 0);

-- A line may point at a quote for its historical source, but later quote
-- quantity/price/validity changes must not invalidate the saved commitment.
-- The identity used to link a quote to the order is protected while the
-- quote remains referenced by a commitment line.
CREATE OR REPLACE FUNCTION protect_purchase_commitment_quote_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND EXISTS (
      SELECT 1 FROM "purchase_commitment_lines"
      WHERE "sourceSupplierQuoteId" = OLD."id"
    )
    AND ROW(NEW."supplierId", NEW."rfqLineId", NEW."partNumber") IS DISTINCT FROM
        ROW(OLD."supplierId", OLD."rfqLineId", OLD."partNumber") THEN
    RAISE EXCEPTION 'Supplier quote identity is immutable while referenced by a purchase commitment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_purchase_commitment_quote_identity_trigger
  BEFORE UPDATE ON "supplier_quotes"
  FOR EACH ROW EXECUTE FUNCTION protect_purchase_commitment_quote_identity();

-- Preserve the order-line identity that a commitment captured. This also
-- prevents changing a modern order back to the legacy shape while it is used
-- by a commitment.
CREATE OR REPLACE FUNCTION protect_purchase_commitment_order_line_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND EXISTS (
      SELECT 1 FROM "purchase_commitment_lines"
      WHERE "orderLineId" = OLD."id"
    )
    AND ROW(NEW."orderId", NEW."quotationLineId", NEW."partNumber", NEW."uom") IS DISTINCT FROM
        ROW(OLD."orderId", OLD."quotationLineId", OLD."partNumber", OLD."uom") THEN
    RAISE EXCEPTION 'Order-line identity is immutable while referenced by a purchase commitment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_purchase_commitment_order_line_identity_trigger
  BEFORE UPDATE ON "order_lines"
  FOR EACH ROW EXECUTE FUNCTION protect_purchase_commitment_order_line_identity();

CREATE OR REPLACE FUNCTION protect_purchase_commitment_order_mode()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."lineItemsMode" IS DISTINCT FROM OLD."lineItemsMode"
    AND NEW."lineItemsMode" = FALSE
    AND EXISTS (
      SELECT 1
      FROM "purchase_commitments" pc
      JOIN "purchase_commitment_lines" pcl
        ON pcl."purchaseCommitmentId" = pc."id"
      WHERE pc."orderId" = OLD."id"
    ) THEN
    RAISE EXCEPTION 'An order used by a purchase commitment must remain in modern line mode';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_purchase_commitment_order_mode_trigger
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION protect_purchase_commitment_order_mode();

-- The source and order-line checks intentionally do not read current quote
-- price, quantity, or validity. Those facts are captured in sourceSnapshot
-- and are checked by the create/submit/approve service before confirmation.
CREATE OR REPLACE FUNCTION assert_purchase_commitment_line_row(line_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_commitment_supplier TEXT;
  v_commitment_order TEXT;
  v_order_line_order TEXT;
  v_order_modern BOOLEAN;
  v_line_part TEXT;
  v_line_uom TEXT;
  v_order_line_part TEXT;
  v_order_line_uom TEXT;
  v_quote_supplier TEXT;
  v_quote_rfq_line TEXT;
  v_quote_part TEXT;
  v_order_line_rfq_line TEXT;
  v_source_quote TEXT;
BEGIN
  SELECT pc."supplierId", pc."orderId", pcl."partNumber", pcl."uom",
    ol."orderId", o."lineItemsMode", ol."partNumber", ol."uom",
    q."supplierId", q."rfqLineId", q."partNumber", ql."rfqLineId",
    pcl."sourceSupplierQuoteId"
  INTO v_commitment_supplier, v_commitment_order, v_line_part, v_line_uom,
    v_order_line_order, v_order_modern, v_order_line_part, v_order_line_uom,
    v_quote_supplier, v_quote_rfq_line, v_quote_part, v_order_line_rfq_line,
    v_source_quote
  FROM "purchase_commitment_lines" pcl
  JOIN "purchase_commitments" pc ON pc."id" = pcl."purchaseCommitmentId"
  JOIN "order_lines" ol ON ol."id" = pcl."orderLineId"
  JOIN "orders" o ON o."id" = ol."orderId"
  JOIN "quotation_lines" ql ON ql."id" = ol."quotationLineId"
  LEFT JOIN "supplier_quotes" q ON q."id" = pcl."sourceSupplierQuoteId"
  WHERE pcl."id" = line_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_order_line_order IS DISTINCT FROM v_commitment_order
    OR v_order_modern IS DISTINCT FROM TRUE
    OR v_line_part IS DISTINCT FROM v_order_line_part
    OR v_line_uom IS DISTINCT FROM v_order_line_uom THEN
    RAISE EXCEPTION 'Purchase commitment line must reference a matching modern order line';
  END IF;

  IF v_source_quote IS NOT NULL
    AND (v_quote_supplier IS DISTINCT FROM v_commitment_supplier
      OR v_quote_rfq_line IS DISTINCT FROM v_order_line_rfq_line
      OR v_quote_part IS DISTINCT FROM v_line_part) THEN
    RAISE EXCEPTION 'Purchase commitment source quote does not match supplier, RFQ line, or part';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_purchase_commitment_integrity(commitment_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
  v_total_cost NUMERIC;
  v_line_total NUMERIC;
  v_line_count BIGINT;
  v_line_id TEXT;
  v_bad_counter BOOLEAN;
BEGIN
  SELECT "status"::TEXT, "totalCost"
  INTO v_status, v_total_cost
  FROM "purchase_commitments"
  WHERE "id" = commitment_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*), COALESCE(SUM("lineTotal"), 0)
  INTO v_line_count, v_line_total
  FROM "purchase_commitment_lines"
  WHERE "purchaseCommitmentId" = commitment_id;

  IF v_total_cost IS DISTINCT FROM v_line_total THEN
    RAISE EXCEPTION 'Purchase commitment totalCost must equal the sum of lineTotal';
  END IF;
  IF v_status <> 'DRAFT' AND v_line_count = 0 THEN
    RAISE EXCEPTION 'A non-draft purchase commitment must contain at least one line';
  END IF;

  FOR v_line_id IN
    SELECT "id" FROM "purchase_commitment_lines"
    WHERE "purchaseCommitmentId" = commitment_id
  LOOP
    PERFORM assert_purchase_commitment_line_row(v_line_id);
  END LOOP;

  IF v_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED') THEN
    SELECT EXISTS (
      SELECT 1 FROM "purchase_commitment_lines"
      WHERE "purchaseCommitmentId" = commitment_id
        AND ("cancelledQuantity" <> 0 OR "receivedQuantity" <> 0
          OR "directShippedQuantity" <> 0)
    ) INTO v_bad_counter;
    IF v_bad_counter THEN
      RAISE EXCEPTION 'Purchase commitment counters must be zero before confirmation';
    END IF;
  ELSIF v_status = 'CANCELLED' THEN
    SELECT EXISTS (
      SELECT 1 FROM "purchase_commitment_lines"
      WHERE "purchaseCommitmentId" = commitment_id
        AND ("receivedQuantity" <> 0 OR "directShippedQuantity" <> 0)
    ) INTO v_bad_counter;
    IF v_bad_counter THEN
      RAISE EXCEPTION 'A cancelled purchase commitment cannot contain received or direct-shipped quantity';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION protect_purchase_commitment_header()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::TEXT <> 'DRAFT' THEN
      RAISE EXCEPTION 'A non-draft purchase commitment cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION 'Purchase commitment version must increase on update';
  END IF;
  IF ROW(NEW."id", NEW."commitmentNumber", NEW."createdById", NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id", OLD."commitmentNumber", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'Purchase commitment identity and creation facts are immutable';
  END IF;
  IF OLD."status"::TEXT <> 'DRAFT'
    AND ROW(NEW."orderId", NEW."supplierId", NEW."currency", NEW."totalCost",
      NEW."paymentTerms", NEW."approvalSnapshot") IS DISTINCT FROM
        ROW(OLD."orderId", OLD."supplierId", OLD."currency", OLD."totalCost",
      OLD."paymentTerms", OLD."approvalSnapshot") THEN
    RAISE EXCEPTION 'Commercial fields cannot be changed outside DRAFT';
  END IF;
  IF OLD."status"::TEXT IN ('CONFIRMED', 'CLOSED')
    AND ROW(NEW."confirmedById", NEW."confirmedAt", NEW."supplierReferenceNo",
      NEW."confirmationEvidence") IS DISTINCT FROM
        ROW(OLD."confirmedById", OLD."confirmedAt", OLD."supplierReferenceNo",
      OLD."confirmationEvidence") THEN
    RAISE EXCEPTION 'Confirmation fields cannot be changed after confirmation';
  END IF;
  IF OLD."status"::TEXT <> 'DRAFT'
    AND NOT (OLD."status"::TEXT = 'APPROVED' AND NEW."status"::TEXT = 'CONFIRMED')
    AND ROW(NEW."supplierReferenceNo", NEW."confirmationEvidence") IS DISTINCT FROM
        ROW(OLD."supplierReferenceNo", OLD."confirmationEvidence") THEN
    RAISE EXCEPTION 'Confirmation fields can only be set while confirming an approved commitment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_purchase_commitment_header_trigger
  BEFORE UPDATE OR DELETE ON "purchase_commitments"
  FOR EACH ROW EXECUTE FUNCTION protect_purchase_commitment_header();

CREATE OR REPLACE FUNCTION protect_purchase_commitment_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status"::TEXT INTO v_status
    FROM "purchase_commitments"
    WHERE "id" = NEW."purchaseCommitmentId";
    IF v_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Lines may only be inserted into a DRAFT purchase commitment';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT "status"::TEXT INTO v_status
    FROM "purchase_commitments"
    WHERE "id" = OLD."purchaseCommitmentId";
    IF v_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Lines may only be deleted from a DRAFT purchase commitment';
    END IF;
    RETURN OLD;
  END IF;

  SELECT "status"::TEXT INTO v_status
  FROM "purchase_commitments"
  WHERE "id" = OLD."purchaseCommitmentId";

  IF NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION 'Purchase commitment line version must increase on update';
  END IF;
  IF ROW(NEW."id", NEW."purchaseCommitmentId", NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id", OLD."purchaseCommitmentId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Purchase commitment line identity and creation facts are immutable';
  END IF;
  IF v_status IS DISTINCT FROM 'DRAFT'
    AND ROW(NEW."purchaseCommitmentId", NEW."lineNo", NEW."orderLineId",
      NEW."sourceSupplierQuoteId", NEW."partNumber", NEW."uom", NEW."quantity",
      NEW."unitCost", NEW."lineTotal", NEW."currency", NEW."promisedDate",
      NEW."fulfillmentMode", NEW."sourceSnapshot", NEW."identitySnapshot") IS DISTINCT FROM
        ROW(OLD."purchaseCommitmentId", OLD."lineNo", OLD."orderLineId",
      OLD."sourceSupplierQuoteId", OLD."partNumber", OLD."uom", OLD."quantity",
      OLD."unitCost", OLD."lineTotal", OLD."currency", OLD."promisedDate",
      OLD."fulfillmentMode", OLD."sourceSnapshot", OLD."identitySnapshot") THEN
    RAISE EXCEPTION 'Purchase commitment line commercial fields cannot change after DRAFT';
  END IF;

  IF v_status = 'CONFIRMED'
    AND (NEW."cancelledQuantity" < OLD."cancelledQuantity"
      OR NEW."receivedQuantity" < OLD."receivedQuantity"
      OR NEW."directShippedQuantity" < OLD."directShippedQuantity") THEN
    RAISE EXCEPTION 'Confirmed purchase commitment counters must be monotonic';
  ELSIF v_status = 'CLOSED'
    AND ROW(NEW."cancelledQuantity", NEW."receivedQuantity", NEW."directShippedQuantity") IS DISTINCT FROM
        ROW(OLD."cancelledQuantity", OLD."receivedQuantity", OLD."directShippedQuantity") THEN
    RAISE EXCEPTION 'Closed purchase commitment lines are immutable';
  ELSIF v_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED')
    AND (NEW."cancelledQuantity" <> 0 OR NEW."receivedQuantity" <> 0
      OR NEW."directShippedQuantity" <> 0) THEN
    RAISE EXCEPTION 'Purchase commitment counters must be zero before confirmation';
  ELSIF v_status = 'CANCELLED'
    AND (NEW."receivedQuantity" <> OLD."receivedQuantity"
      OR NEW."directShippedQuantity" <> OLD."directShippedQuantity"
      OR NEW."cancelledQuantity" < OLD."cancelledQuantity") THEN
    RAISE EXCEPTION 'Cancelled purchase commitment lines only allow increasing cancelled quantity';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_purchase_commitment_line_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON "purchase_commitment_lines"
  FOR EACH ROW EXECUTE FUNCTION protect_purchase_commitment_line();

CREATE OR REPLACE FUNCTION protect_purchase_commitment_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Purchase commitment events are append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_purchase_commitment_event_trigger
  BEFORE UPDATE OR DELETE ON "purchase_commitment_events"
  FOR EACH ROW EXECUTE FUNCTION protect_purchase_commitment_event();

CREATE OR REPLACE FUNCTION validate_purchase_commitment_integrity_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_purchase_commitment_integrity(OLD."purchaseCommitmentId");
  ELSIF TG_TABLE_NAME = 'purchase_commitment_lines' THEN
    PERFORM assert_purchase_commitment_integrity(NEW."purchaseCommitmentId");
  ELSE
    PERFORM assert_purchase_commitment_integrity(NEW."id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER purchase_commitment_header_integrity
  AFTER INSERT OR UPDATE ON "purchase_commitments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_purchase_commitment_integrity_trigger();

CREATE CONSTRAINT TRIGGER purchase_commitment_line_integrity
  AFTER INSERT OR UPDATE OR DELETE ON "purchase_commitment_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_purchase_commitment_integrity_trigger();
