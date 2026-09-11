-- Supplier-direct shipment plans and their immutable quality / receipt history.
-- This migration deliberately does not backfill the new direct-shipped projections:
-- there are no historical supplier-direct rows in the database at this point.

CREATE TYPE "SupplierDirectShipmentStatus" AS ENUM (
    'PREPARED',
    'CANCELLED',
    'DISPATCHED',
    'PARTIALLY_RECEIVED',
    'DELIVERED'
);

CREATE TYPE "SupplierDirectShipmentReviewStatus" AS ENUM (
    'PENDING_REVIEW',
    'APPROVED',
    'REJECTED'
);

ALTER TABLE "orders"
    ADD COLUMN "directShippedQuantity" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "order_lines"
    ADD COLUMN "directShippedQuantity" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_directShippedQuantity_check"
    CHECK ("directShippedQuantity" >= 0
       AND "outboundQuantity" >= 0
       AND "outboundQuantity"::BIGINT + "directShippedQuantity"::BIGINT <= "quantity");

ALTER TABLE "order_lines"
    ADD CONSTRAINT "order_lines_directShippedQuantity_check"
    CHECK ("directShippedQuantity" >= 0
       AND "outboundQuantity" >= 0
       AND "outboundQuantity"::BIGINT + "directShippedQuantity"::BIGINT <= "quantity");

ALTER TABLE "purchase_commitment_lines"
    DROP CONSTRAINT IF EXISTS "purchase_commitment_lines_business_values_check";

ALTER TABLE "purchase_commitment_lines"
    ADD CONSTRAINT "purchase_commitment_lines_business_values_check" CHECK (
        "lineNo" > 0
        AND length(btrim("partNumber")) > 0
        AND length(btrim("uom")) > 0
        AND "quantity" > 0
        AND "cancelledQuantity" >= 0
        AND "receivedQuantity" >= 0
        AND "directShippedQuantity" >= 0
        AND ("cancelledQuantity"::BIGINT + "receivedQuantity"::BIGINT + "directShippedQuantity"::BIGINT) <= "quantity"
        AND "unitCost" >= 0
        AND "lineTotal" >= 0
        AND "lineTotal" = ("unitCost" * "quantity")
        AND "currency" = 'USD'
        AND "version" > 0
        AND (
            ("fulfillmentMode" = 'STOCK_RECEIPT' AND "directShippedQuantity" = 0)
            OR ("fulfillmentMode" = 'SUPPLIER_DIRECT' AND "receivedQuantity" = 0)
        )
    );

CREATE TABLE "supplier_direct_shipments" (
    "id" TEXT NOT NULL,
    "shipmentNumber" TEXT NOT NULL,
    "purchaseCommitmentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "SupplierDirectShipmentStatus" NOT NULL DEFAULT 'PREPARED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "commandId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_direct_shipments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_direct_shipments_values_check" CHECK (
        length(btrim("id")) > 0
        AND length(btrim("shipmentNumber")) > 0
        AND length(btrim("carrier")) > 0
        AND length(btrim("trackingNumber")) > 0
        AND length(btrim("origin")) > 0
        AND length(btrim("destination")) > 0
        AND length(btrim("reason")) > 0
        AND length(btrim("commandId")) > 0
        AND length(btrim("requestHash")) > 0
        AND "version" > 0
        AND jsonb_typeof("evidence") = 'object'
        AND (("status" = 'PREPARED' AND "dispatchedById" IS NULL AND "dispatchedAt" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
             OR ("status" = 'CANCELLED' AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "dispatchedById" IS NULL AND "dispatchedAt" IS NULL)
             OR ("status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED') AND "dispatchedById" IS NOT NULL AND "dispatchedAt" IS NOT NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL))
    )
);

CREATE TABLE "supplier_direct_shipment_lines" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "purchaseCommitmentLineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "physicalSnapshot" JSONB NOT NULL,
    "reviewStatus" "SupplierDirectShipmentReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "checks" JSONB,
    "reviewSnapshot" JSONB,
    "reviewSnapshotHash" TEXT,
    "reviewEvidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "serialClaimKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_direct_shipment_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_direct_shipment_lines_values_check" CHECK (
        length(btrim("id")) > 0
        AND "lineNo" > 0
        AND "lineNo" <= 100
        AND "quantity" > 0
        AND "receivedQuantity" >= 0
        AND "receivedQuantity" <= "quantity"
        AND "version" > 0
        AND jsonb_typeof("physicalSnapshot") = 'object'
        AND jsonb_typeof("reviewEvidence") = 'array'
        AND ("checks" IS NULL OR jsonb_typeof("checks") = 'object')
        AND ("reviewSnapshot" IS NULL OR jsonb_typeof("reviewSnapshot") = 'object')
        AND ("reviewStatus" = 'PENDING_REVIEW'
             OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND length(btrim(COALESCE("reviewReason", ''))) > 0
                 AND "checks" IS NOT NULL AND jsonb_typeof("checks") = 'object'
                 AND "reviewSnapshot" IS NOT NULL AND "reviewSnapshotHash" IS NOT NULL AND length(btrim("reviewSnapshotHash")) > 0))
    )
);

CREATE TABLE "supplier_direct_shipment_events" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "shipmentLineId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "eventNo" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_direct_shipment_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_direct_shipment_events_values_check" CHECK (
        length(btrim("id")) > 0
        AND "kind" IN ('CREATE', 'APPROVE', 'REJECT', 'DISPATCH', 'CANCEL', 'RECEIPT')
        AND "quantity" >= 0
        AND length(btrim("actorId")) > 0
        AND length(btrim("commandId")) > 0
        AND "eventNo" > 0
        AND length(btrim("requestHash")) > 0
        AND jsonb_typeof("data") = 'object'
    )
);

CREATE UNIQUE INDEX "supplier_direct_shipments_shipmentNumber_key"
    ON "supplier_direct_shipments" ("shipmentNumber");
CREATE UNIQUE INDEX "supplier_direct_shipments_commandId_key"
    ON "supplier_direct_shipments" ("commandId");
CREATE UNIQUE INDEX "supplier_direct_shipment_line_serial_claim_key"
    ON "supplier_direct_shipment_lines" ("serialClaimKey");
CREATE UNIQUE INDEX "supplier_direct_shipment_event_command_event_key"
    ON "supplier_direct_shipment_events" ("commandId", "eventNo");
CREATE UNIQUE INDEX "supplier_direct_shipment_lines_shipmentId_lineNo_key"
    ON "supplier_direct_shipment_lines" ("shipmentId", "lineNo");

CREATE INDEX "supplier_direct_shipments_purchase_status_idx"
    ON "supplier_direct_shipments" ("purchaseCommitmentId", "status");
CREATE INDEX "supplier_direct_shipments_order_status_idx"
    ON "supplier_direct_shipments" ("orderId", "status");
CREATE INDEX "supplier_direct_shipment_lines_purchase_review_idx"
    ON "supplier_direct_shipment_lines" ("purchaseCommitmentLineId", "reviewStatus");
CREATE INDEX "supplier_direct_shipment_lines_shipment_review_idx"
    ON "supplier_direct_shipment_lines" ("shipmentId", "reviewStatus");
CREATE INDEX "supplier_direct_shipment_events_shipment_event_idx"
    ON "supplier_direct_shipment_events" ("shipmentId", "eventNo");
CREATE INDEX "supplier_direct_shipment_events_line_created_idx"
    ON "supplier_direct_shipment_events" ("shipmentLineId", "createdAt");
CREATE INDEX "supplier_direct_shipment_events_actor_created_idx"
    ON "supplier_direct_shipment_events" ("actorId", "createdAt");

ALTER TABLE "supplier_direct_shipments"
    ADD CONSTRAINT "supplier_direct_shipments_purchaseCommitmentId_fkey"
        FOREIGN KEY ("purchaseCommitmentId") REFERENCES "purchase_commitments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipments_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipments_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipments_dispatchedById_fkey"
        FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipments_cancelledById_fkey"
        FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_direct_shipment_lines"
    ADD CONSTRAINT "supplier_direct_shipment_lines_shipmentId_fkey"
        FOREIGN KEY ("shipmentId") REFERENCES "supplier_direct_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipment_lines_purchaseCommitmentLineId_fkey"
        FOREIGN KEY ("purchaseCommitmentLineId") REFERENCES "purchase_commitment_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipment_lines_reviewedById_fkey"
        FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_direct_shipment_events"
    ADD CONSTRAINT "supplier_direct_shipment_events_shipmentId_fkey"
        FOREIGN KEY ("shipmentId") REFERENCES "supplier_direct_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipment_events_shipmentLineId_fkey"
        FOREIGN KEY ("shipmentLineId") REFERENCES "supplier_direct_shipment_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "supplier_direct_shipment_events_actorId_fkey"
        FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep the existing CAS semantics for purchase lines and reuse the SQL-only
-- order-line coverage row as the stable row lock.  We intentionally do not
-- update a shipment head from a purchase-line trigger, avoiding trigger loops.
CREATE OR REPLACE FUNCTION lock_supplier_direct_scope_v11(p_shipment_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_pc_id TEXT;
    v_order_id TEXT;
    v_pcl_id TEXT;
    v_order_line_id TEXT;
BEGIN
    SELECT "purchaseCommitmentId", "orderId"
      INTO v_pc_id, v_order_id
      FROM "supplier_direct_shipments"
     WHERE id = p_shipment_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'supplier direct shipment % not found', p_shipment_id USING ERRCODE = '23514';
    END IF;

    FOR v_pcl_id, v_order_line_id IN
        SELECT DISTINCT l."purchaseCommitmentLineId", pcl."orderLineId"
          FROM "supplier_direct_shipment_lines" l
          JOIN "purchase_commitment_lines" pcl ON pcl.id = l."purchaseCommitmentLineId"
         WHERE l."shipmentId" = p_shipment_id
         ORDER BY l."purchaseCommitmentLineId", pcl."orderLineId"
    LOOP
        UPDATE "purchase_commitment_lines"
           SET "version" = "version" + 1
         WHERE id = v_pcl_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'purchase commitment line % not found', v_pcl_id USING ERRCODE = '23514';
        END IF;

        PERFORM lock_order_line_coverage_row(v_order_line_id);
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION direct_supplier_json_text_v11(p_value JSONB, p_key TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE WHEN jsonb_typeof(p_value -> p_key) = 'string' THEN p_value ->> p_key ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION assert_supplier_direct_line_facts_v11(p_line_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_line RECORD;
    v_snapshot JSONB;
    v_identity JSONB;
    v_expected_serial TEXT;
    v_expected_batch TEXT;
    v_expected_tracking TEXT;
    v_serial TEXT;
    v_batch TEXT;
    v_tracking TEXT;
    v_part TEXT;
    v_uom TEXT;
    v_snapshot_quantity INTEGER;
    v_required_key TEXT;
    v_checks JSONB;
    v_key TEXT;
BEGIN
    SELECT l.*, s."status" AS shipment_status, s."purchaseCommitmentId" AS shipment_pc_id,
           s."orderId" AS shipment_order_id, s."createdById" AS shipment_created_by,
           s."dispatchedById" AS shipment_dispatched_by,
           pcl."purchaseCommitmentId" AS pcl_pc_id, pcl."orderLineId" AS pcl_order_line_id,
           pcl."partNumber" AS pcl_part_number, pcl."uom" AS pcl_uom,
           pcl."quantity" AS pcl_quantity, pcl."receivedQuantity" AS pcl_received,
           pcl."directShippedQuantity" AS pcl_direct,
           pcl."cancelledQuantity" AS pcl_cancelled,
           pcl."fulfillmentMode"::TEXT AS pcl_mode,
           pcl."identitySnapshot" AS pcl_identity,
           pc."status"::TEXT AS pc_status, pc."createdById" AS pc_created_by,
           pc."submittedById" AS pc_submitted_by, pc."confirmedById" AS pc_confirmed_by,
           ol."partNumber" AS order_part_number, ol."uom" AS order_uom,
           ol."orderId" AS order_line_order_id,
           ol."serialNumber" AS order_serial, ol."batchNumber" AS order_batch,
           ol."quantity" AS order_quantity
      INTO v_line
      FROM "supplier_direct_shipment_lines" l
      JOIN "supplier_direct_shipments" s ON s.id = l."shipmentId"
      JOIN "purchase_commitment_lines" pcl ON pcl.id = l."purchaseCommitmentLineId"
      JOIN "purchase_commitments" pc ON pc.id = pcl."purchaseCommitmentId"
      JOIN "order_lines" ol ON ol.id = pcl."orderLineId"
     WHERE l.id = p_line_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'supplier direct shipment line % not found', p_line_id USING ERRCODE = '23514';
    END IF;

    IF v_line.shipment_pc_id <> v_line.pcl_pc_id OR v_line.pcl_pc_id IS NULL THEN
        RAISE EXCEPTION 'supplier direct shipment line % crosses purchase commitment', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_line.shipment_order_id IS NULL OR v_line.pcl_order_line_id IS NULL
       OR v_line.order_line_order_id IS DISTINCT FROM v_line.shipment_order_id THEN
        RAISE EXCEPTION 'supplier direct shipment line % has no order scope', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_line.pcl_mode <> 'SUPPLIER_DIRECT' OR v_line.pcl_received <> 0 THEN
        RAISE EXCEPTION 'supplier direct line % requires an unused SUPPLIER_DIRECT purchase line', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_line.pc_status NOT IN ('CONFIRMED', 'CLOSED')
       AND NOT (v_line.shipment_status = 'CANCELLED' AND v_line.pc_status = 'CANCELLED') THEN
        RAISE EXCEPTION 'supplier direct line % requires CONFIRMED or CLOSED purchase commitment', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_line.shipment_status = 'PREPARED' AND v_line.pc_status <> 'CONFIRMED' THEN
        RAISE EXCEPTION 'PREPARED supplier direct shipment % requires CONFIRMED purchase commitment', v_line."shipmentId" USING ERRCODE = '23514';
    END IF;
    IF v_line.quantity <= 0 OR v_line.quantity > v_line.pcl_quantity THEN
        RAISE EXCEPTION 'supplier direct line % quantity is outside purchase quantity', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_line.quantity > v_line.order_quantity THEN
        RAISE EXCEPTION 'supplier direct line % exceeds order line quantity', p_line_id USING ERRCODE = '23514';
    END IF;

    v_snapshot := v_line."physicalSnapshot";
    IF jsonb_typeof(v_snapshot) <> 'object' THEN
        RAISE EXCEPTION 'supplier direct line % physical snapshot must be an object', p_line_id USING ERRCODE = '23514';
    END IF;
    v_part := direct_supplier_json_text_v11(v_snapshot, 'partNumber');
    v_uom := direct_supplier_json_text_v11(v_snapshot, 'uom');
    v_serial := direct_supplier_json_text_v11(v_snapshot, 'serialNumber');
    v_batch := direct_supplier_json_text_v11(v_snapshot, 'batchNumber');
    v_tracking := upper(COALESCE(direct_supplier_json_text_v11(v_snapshot, 'trackingType'), ''));
    v_snapshot_quantity := CASE
        WHEN jsonb_typeof(v_snapshot -> 'quantity') = 'number' THEN (v_snapshot ->> 'quantity')::INTEGER
        ELSE NULL
    END;
    v_identity := CASE WHEN jsonb_typeof(v_line.pcl_identity) = 'object' THEN v_line.pcl_identity ELSE '{}'::jsonb END;
    v_expected_serial := COALESCE(v_line.order_serial, direct_supplier_json_text_v11(v_identity, 'serialNumber'));
    v_expected_batch := COALESCE(v_line.order_batch, direct_supplier_json_text_v11(v_identity, 'batchNumber'));
    v_expected_tracking := upper(COALESCE(direct_supplier_json_text_v11(v_identity, 'trackingType'), CASE WHEN v_expected_serial IS NOT NULL THEN 'SERIAL' ELSE 'BATCH' END));

    IF v_part IS NULL OR v_part <> v_line.pcl_part_number OR v_part <> v_line.order_part_number THEN
        RAISE EXCEPTION 'supplier direct line % part number does not match purchase/order identity', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_uom IS NULL OR v_uom <> v_line.pcl_uom OR v_uom <> v_line.order_uom THEN
        RAISE EXCEPTION 'supplier direct line % UOM does not match purchase/order identity', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_snapshot_quantity IS NULL OR v_snapshot_quantity <> v_line.quantity THEN
        RAISE EXCEPTION 'supplier direct line % physical quantity does not match line quantity', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_tracking NOT IN ('SERIAL', 'BATCH') OR v_tracking <> v_expected_tracking THEN
        RAISE EXCEPTION 'supplier direct line % tracking type does not match purchase identity', p_line_id USING ERRCODE = '23514';
    END IF;
    IF v_tracking = 'SERIAL' THEN
        IF v_line.quantity <> 1 OR v_serial IS NULL OR length(btrim(v_serial)) = 0
           OR v_expected_serial IS NULL OR v_serial <> v_expected_serial OR v_batch IS NOT NULL THEN
            RAISE EXCEPTION 'supplier direct serial line % has invalid physical identity', p_line_id USING ERRCODE = '23514';
        END IF;
    ELSE
        IF v_serial IS NOT NULL OR v_batch IS NULL OR length(btrim(v_batch)) = 0 OR (v_expected_batch IS NOT NULL AND v_batch <> v_expected_batch) THEN
            RAISE EXCEPTION 'supplier direct batch line % has invalid physical identity', p_line_id USING ERRCODE = '23514';
        END IF;
    END IF;

    IF v_line."reviewStatus"::TEXT IN ('REJECTED') OR v_line.shipment_status = 'CANCELLED' THEN
        IF v_line."serialClaimKey" IS NOT NULL THEN
            RAISE EXCEPTION 'rejected/cancelled supplier direct line % cannot keep a serial claim', p_line_id USING ERRCODE = '23514';
        END IF;
    ELSIF v_tracking = 'SERIAL' THEN
        v_required_key := char_length(v_part)::TEXT || ':' || v_part || v_serial;
        IF v_line."serialClaimKey" IS DISTINCT FROM v_required_key THEN
            RAISE EXCEPTION 'supplier direct serial line % has an invalid serial claim', p_line_id USING ERRCODE = '23514';
        END IF;
    ELSIF v_line."serialClaimKey" IS NOT NULL THEN
        RAISE EXCEPTION 'supplier direct batch line % cannot have a serial claim', p_line_id USING ERRCODE = '23514';
    END IF;

    IF v_line."reviewStatus"::TEXT IN ('APPROVED', 'REJECTED') THEN
        v_checks := v_line."checks";
        FOREACH v_key IN ARRAY ARRAY['identity', 'documents', 'conditionAndLife', 'customerRequirements']
        LOOP
            IF jsonb_typeof(v_checks -> v_key) IS DISTINCT FROM 'boolean' THEN
                RAISE EXCEPTION 'supplier direct line % quality checks are incomplete', p_line_id USING ERRCODE = '23514';
            END IF;
        END LOOP;
        IF v_line."reviewStatus"::TEXT = 'APPROVED' AND EXISTS (
            SELECT 1 FROM jsonb_each(v_checks) c WHERE c.key IN ('identity', 'documents', 'conditionAndLife', 'customerRequirements') AND c.value <> 'true'::jsonb
        ) THEN
            RAISE EXCEPTION 'approved supplier direct line % has a failed quality check', p_line_id USING ERRCODE = '23514';
        END IF;
        IF v_line."reviewedById" IN (v_line.shipment_created_by, v_line.pc_created_by, v_line.pc_submitted_by, v_line.pc_confirmed_by) THEN
            RAISE EXCEPTION 'supplier direct line % reviewer is not independent', p_line_id USING ERRCODE = '23514';
        END IF;
        IF v_line.shipment_dispatched_by IS NOT NULL AND v_line."reviewedById" = v_line.shipment_dispatched_by THEN
            RAISE EXCEPTION 'supplier direct line % reviewer cannot dispatch the shipment', p_line_id USING ERRCODE = '23514';
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_supplier_direct_head_integrity_v11(p_shipment_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_head RECORD;
    v_line_id TEXT;
    v_pcl RECORD;
    v_order_line RECORD;
    v_line_count BIGINT;
    v_total_quantity BIGINT;
    v_received_quantity BIGINT;
    v_active_quantity BIGINT;
    v_prepared_quantity BIGINT;
    v_pcl_direct BIGINT;
    v_pcl_prepared BIGINT;
    v_order_line_direct BIGINT;
    v_order_direct BIGINT;
    v_bad BOOLEAN;
    v_create_events BIGINT;
    v_dispatch_events BIGINT;
    v_cancel_events BIGINT;
    v_decision_events BIGINT;
BEGIN
    SELECT s.*, pc."status"::TEXT AS pc_status, pc."orderId" AS pc_order_id,
           pc."supplierId" AS pc_supplier_id
      INTO v_head
      FROM "supplier_direct_shipments" s
      JOIN "purchase_commitments" pc ON pc.id = s."purchaseCommitmentId"
     WHERE s.id = p_shipment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'supplier direct shipment % not found', p_shipment_id USING ERRCODE = '23514';
    END IF;

    IF v_head."status"::TEXT = 'PREPARED' AND v_head.pc_status <> 'CONFIRMED' THEN
        RAISE EXCEPTION 'PREPARED supplier direct shipment % requires CONFIRMED purchase commitment', p_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_head."status"::TEXT IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED')
       AND v_head.pc_status NOT IN ('CONFIRMED', 'CLOSED') THEN
        RAISE EXCEPTION 'active supplier direct shipment % has an invalid purchase commitment status', p_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_head."status"::TEXT = 'CANCELLED' AND v_head.pc_status NOT IN ('CONFIRMED', 'CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'cancelled supplier direct shipment % has an invalid purchase commitment status', p_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_head.pc_order_id IS DISTINCT FROM v_head."orderId" THEN
        RAISE EXCEPTION 'supplier direct shipment % crosses order and purchase commitment', p_shipment_id USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*), COALESCE(SUM("quantity"), 0), COALESCE(SUM("receivedQuantity"), 0)
      INTO v_line_count, v_total_quantity, v_received_quantity
      FROM "supplier_direct_shipment_lines"
     WHERE "shipmentId" = p_shipment_id;
    IF v_line_count = 0 THEN
        RAISE EXCEPTION 'supplier direct shipment % must contain at least one line', p_shipment_id USING ERRCODE = '23514';
    END IF;

    FOR v_line_id IN
        SELECT "id" FROM "supplier_direct_shipment_lines"
         WHERE "shipmentId" = p_shipment_id ORDER BY "lineNo", "id"
    LOOP
        PERFORM assert_supplier_direct_line_facts_v11(v_line_id);
        SELECT COUNT(*) INTO v_decision_events
          FROM "supplier_direct_shipment_events"
         WHERE "shipmentLineId" = v_line_id AND "kind" = 'APPROVE';
        IF EXISTS (SELECT 1 FROM "supplier_direct_shipment_lines" WHERE "id" = v_line_id AND "reviewStatus" = 'APPROVED')
           AND v_decision_events <> 1 THEN
            RAISE EXCEPTION 'approved supplier direct line % must have exactly one APPROVE event', v_line_id USING ERRCODE = '23514';
        ELSIF EXISTS (SELECT 1 FROM "supplier_direct_shipment_lines" WHERE "id" = v_line_id AND "reviewStatus" <> 'APPROVED')
           AND v_decision_events <> 0 THEN
            RAISE EXCEPTION 'non-approved supplier direct line % cannot have an APPROVE event', v_line_id USING ERRCODE = '23514';
        END IF;
        SELECT COUNT(*) INTO v_decision_events
          FROM "supplier_direct_shipment_events"
         WHERE "shipmentLineId" = v_line_id AND "kind" = 'REJECT';
        IF EXISTS (SELECT 1 FROM "supplier_direct_shipment_lines" WHERE "id" = v_line_id AND "reviewStatus" = 'REJECTED')
           AND v_decision_events <> 1 THEN
            RAISE EXCEPTION 'rejected supplier direct line % must have exactly one REJECT event', v_line_id USING ERRCODE = '23514';
        ELSIF EXISTS (SELECT 1 FROM "supplier_direct_shipment_lines" WHERE "id" = v_line_id AND "reviewStatus" <> 'REJECTED')
           AND v_decision_events <> 0 THEN
            RAISE EXCEPTION 'non-rejected supplier direct line % cannot have a REJECT event', v_line_id USING ERRCODE = '23514';
        END IF;
    END LOOP;

    SELECT COUNT(*) INTO v_create_events
      FROM "supplier_direct_shipment_events"
     WHERE "shipmentId" = p_shipment_id AND "kind" = 'CREATE'
       AND "shipmentLineId" IS NULL AND "quantity" = 0;
    IF v_create_events <> 1 THEN
        RAISE EXCEPTION 'supplier direct shipment % must have exactly one CREATE event', p_shipment_id USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "supplier_direct_shipment_events"
         WHERE "shipmentId" = p_shipment_id AND "kind" = 'CREATE'
           AND "shipmentLineId" IS NULL AND "quantity" = 0
           AND "commandId" = v_head."commandId" AND "requestHash" = v_head."requestHash"
    ) THEN
        RAISE EXCEPTION 'supplier direct shipment % CREATE event does not match its command identity', p_shipment_id USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*) INTO v_dispatch_events
      FROM "supplier_direct_shipment_events"
     WHERE "shipmentId" = p_shipment_id AND "kind" = 'DISPATCH'
       AND "shipmentLineId" IS NULL AND "quantity" = 0;
    SELECT COUNT(*) INTO v_cancel_events
      FROM "supplier_direct_shipment_events"
     WHERE "shipmentId" = p_shipment_id AND "kind" = 'CANCEL'
       AND "shipmentLineId" IS NULL AND "quantity" = 0;

    IF v_head."status"::TEXT = 'PREPARED' THEN
        IF v_received_quantity <> 0 OR v_dispatch_events <> 0 OR v_cancel_events <> 0 THEN
            RAISE EXCEPTION 'PREPARED supplier direct shipment % has terminal facts', p_shipment_id USING ERRCODE = '23514';
        END IF;
    ELSIF v_head."status"::TEXT = 'CANCELLED' THEN
        IF v_received_quantity <> 0 OR v_dispatch_events <> 0 OR v_cancel_events <> 1 THEN
            RAISE EXCEPTION 'CANCELLED supplier direct shipment % has invalid events or receipt quantity', p_shipment_id USING ERRCODE = '23514';
        END IF;
    ELSE
        IF v_dispatch_events <> 1 OR v_cancel_events <> 0 THEN
            RAISE EXCEPTION 'active supplier direct shipment % must have exactly one DISPATCH event and no CANCEL event', p_shipment_id USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM "supplier_direct_shipment_lines"
             WHERE "shipmentId" = p_shipment_id AND "reviewStatus" <> 'APPROVED'
        ) INTO v_bad;
        IF v_bad THEN
            RAISE EXCEPTION 'active supplier direct shipment % contains an unapproved line', p_shipment_id USING ERRCODE = '23514';
        END IF;
        IF v_head."status"::TEXT = 'DISPATCHED' AND v_received_quantity <> 0 THEN
            RAISE EXCEPTION 'DISPATCHED supplier direct shipment % cannot have customer receipt', p_shipment_id USING ERRCODE = '23514';
        ELSIF v_head."status"::TEXT = 'PARTIALLY_RECEIVED'
          AND (v_received_quantity <= 0 OR v_received_quantity >= v_total_quantity) THEN
            RAISE EXCEPTION 'PARTIALLY_RECEIVED supplier direct shipment % has an invalid receipt quantity', p_shipment_id USING ERRCODE = '23514';
        ELSIF v_head."status"::TEXT = 'DELIVERED' AND v_received_quantity <> v_total_quantity THEN
            RAISE EXCEPTION 'DELIVERED supplier direct shipment % must be fully received', p_shipment_id USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Every receipt event is the immutable source of the line's customer receipt.
    FOR v_line_id IN
        SELECT "id" FROM "supplier_direct_shipment_lines"
         WHERE "shipmentId" = p_shipment_id
    LOOP
        SELECT COALESCE(SUM("quantity"), 0)
          INTO v_order_line_direct
          FROM "supplier_direct_shipment_events"
         WHERE "shipmentLineId" = v_line_id AND "kind" = 'RECEIPT';
        SELECT "receivedQuantity" INTO v_received_quantity
          FROM "supplier_direct_shipment_lines" WHERE "id" = v_line_id;
        IF v_received_quantity <> v_order_line_direct THEN
            RAISE EXCEPTION 'supplier direct line % receipt counter does not equal RECEIPT events', v_line_id USING ERRCODE = '23514';
        END IF;
    END LOOP;

    -- A purchase line's direct-shipped counter is a projection of all active
    -- direct plans. PREPARED non-rejected plans reserve the remaining capacity.
    FOR v_pcl IN
        SELECT DISTINCT pcl."id", pcl."quantity", pcl."cancelledQuantity", pcl."receivedQuantity",
               pcl."directShippedQuantity", pcl."purchaseCommitmentId"
          FROM "purchase_commitment_lines" pcl
          JOIN "supplier_direct_shipment_lines" dl ON dl."purchaseCommitmentLineId" = pcl."id"
         WHERE pcl."purchaseCommitmentId" = v_head."purchaseCommitmentId"
         ORDER BY pcl."id"
    LOOP
        SELECT COALESCE(SUM(CASE WHEN s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED') THEN dl."quantity" ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN s."status" = 'PREPARED' AND dl."reviewStatus" <> 'REJECTED' THEN dl."quantity" ELSE 0 END), 0)
          INTO v_pcl_direct, v_pcl_prepared
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
         WHERE dl."purchaseCommitmentLineId" = v_pcl."id";
        IF v_pcl_direct <> v_pcl."directShippedQuantity" THEN
            RAISE EXCEPTION 'purchase commitment line % direct-shipped projection is inconsistent', v_pcl."id" USING ERRCODE = '23514';
        END IF;
        IF v_pcl."cancelledQuantity"::BIGINT + v_pcl."receivedQuantity"::BIGINT + v_pcl_direct + v_pcl_prepared > v_pcl."quantity" THEN
            RAISE EXCEPTION 'purchase commitment line % direct plan exceeds available capacity', v_pcl."id" USING ERRCODE = '23514';
        END IF;
    END LOOP;

    -- Each modern order-line direct projection is checked against the active
    -- plan rows. The local outbound projection remains an independent fact.
    FOR v_order_line IN
        SELECT DISTINCT ol."id", ol."orderId", ol."quantity", ol."outboundQuantity", ol."directShippedQuantity"
          FROM "order_lines" ol
          JOIN "purchase_commitment_lines" pcl ON pcl."orderLineId" = ol."id"
          JOIN "supplier_direct_shipment_lines" dl ON dl."purchaseCommitmentLineId" = pcl."id"
         WHERE pcl."purchaseCommitmentId" = v_head."purchaseCommitmentId"
         ORDER BY ol."id"
    LOOP
        SELECT COALESCE(SUM(CASE WHEN s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED') THEN dl."quantity" ELSE 0 END), 0)
          INTO v_order_line_direct
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
          JOIN "purchase_commitment_lines" pcl ON pcl.id = dl."purchaseCommitmentLineId"
         WHERE pcl."orderLineId" = v_order_line."id";
        IF v_order_line_direct <> v_order_line."directShippedQuantity" THEN
            RAISE EXCEPTION 'order line % direct-shipped projection is inconsistent', v_order_line."id" USING ERRCODE = '23514';
        END IF;
        IF v_order_line."outboundQuantity"::BIGINT + v_order_line_direct > v_order_line."quantity" THEN
            RAISE EXCEPTION 'order line % outbound and direct quantities overlap', v_order_line."id" USING ERRCODE = '23514';
        END IF;
    END LOOP;

    SELECT COALESCE(SUM("directShippedQuantity"), 0)
      INTO v_order_direct
      FROM "order_lines"
     WHERE "orderId" = v_head."orderId";
    SELECT "directShippedQuantity" INTO v_active_quantity
      FROM "orders" WHERE "id" = v_head."orderId";
    IF v_order_direct <> v_active_quantity THEN
        RAISE EXCEPTION 'order % direct-shipped projection is inconsistent', v_head."orderId" USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION protect_supplier_direct_shipment_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Supplier direct shipment history is append-only' USING ERRCODE = '23514';
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'PREPARED' OR NEW."version" <> 1
           OR NEW."dispatchedById" IS NOT NULL OR NEW."dispatchedAt" IS NOT NULL
           OR NEW."cancelledById" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
            RAISE EXCEPTION 'A supplier direct shipment must start in PREPARED state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."version" <= OLD."version" THEN
        RAISE EXCEPTION 'Supplier direct shipment version must increase on update' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW."id", NEW."shipmentNumber", NEW."purchaseCommitmentId", NEW."orderId",
        NEW."carrier", NEW."trackingNumber", NEW."origin", NEW."destination", NEW."reason",
        NEW."evidence", NEW."commandId", NEW."requestHash", NEW."createdById", NEW."createdAt") IS DISTINCT FROM
       ROW(OLD."id", OLD."shipmentNumber", OLD."purchaseCommitmentId", OLD."orderId",
        OLD."carrier", OLD."trackingNumber", OLD."origin", OLD."destination", OLD."reason",
        OLD."evidence", OLD."commandId", OLD."requestHash", OLD."createdById", OLD."createdAt") THEN
        RAISE EXCEPTION 'Supplier direct shipment identity and creation facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" <> 'PREPARED'
       AND ROW(NEW."dispatchedById", NEW."dispatchedAt", NEW."cancelledById", NEW."cancelledAt", NEW."cancellationReason") IS DISTINCT FROM
           ROW(OLD."dispatchedById", OLD."dispatchedAt", OLD."cancelledById", OLD."cancelledAt", OLD."cancellationReason") THEN
        RAISE EXCEPTION 'Supplier direct shipment dispatch and cancellation facts are immutable' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" = 'PREPARED' THEN
        IF NEW."status" NOT IN ('PREPARED', 'CANCELLED', 'DISPATCHED') THEN
            RAISE EXCEPTION 'Invalid supplier direct shipment transition from PREPARED' USING ERRCODE = '23514';
        END IF;
        IF NEW."status" = 'CANCELLED'
           AND (NEW."cancelledById" IS NULL OR NEW."cancelledAt" IS NULL
             OR length(btrim(COALESCE(NEW."cancellationReason", ''))) = 0
             OR NEW."dispatchedById" IS NOT NULL OR NEW."dispatchedAt" IS NOT NULL) THEN
            RAISE EXCEPTION 'Cancelling a supplier direct shipment requires an immutable cancellation record' USING ERRCODE = '23514';
        END IF;
        IF NEW."status" = 'DISPATCHED'
           AND (NEW."dispatchedById" IS NULL OR NEW."dispatchedAt" IS NULL
             OR NEW."cancelledById" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL) THEN
            RAISE EXCEPTION 'Dispatching a supplier direct shipment requires an immutable dispatch record' USING ERRCODE = '23514';
        END IF;
    ELSIF OLD."status" = 'DISPATCHED' THEN
        IF NEW."status" NOT IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED')
           OR NEW."dispatchedById" IS DISTINCT FROM OLD."dispatchedById"
           OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
           OR NEW."cancelledById" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid supplier direct shipment transition from DISPATCHED' USING ERRCODE = '23514';
        END IF;
    ELSIF OLD."status" = 'PARTIALLY_RECEIVED' THEN
        IF NEW."status" NOT IN ('PARTIALLY_RECEIVED', 'DELIVERED')
           OR NEW."dispatchedById" IS DISTINCT FROM OLD."dispatchedById"
           OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
           OR NEW."cancelledById" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid supplier direct shipment transition from PARTIALLY_RECEIVED' USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NEW."status" IS DISTINCT FROM OLD."status" THEN
            RAISE EXCEPTION 'A terminal supplier direct shipment cannot change state' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_supplier_direct_shipment_line_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_head_status TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Supplier direct shipment line history is append-only' USING ERRCODE = '23514';
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW."version" <> 1 OR NEW."receivedQuantity" <> 0
           OR NEW."reviewStatus" <> 'PENDING_REVIEW'
           OR NEW."reviewedById" IS NOT NULL OR NEW."reviewedAt" IS NOT NULL
           OR NEW."reviewReason" IS NOT NULL OR NEW."checks" IS NOT NULL
           OR NEW."reviewSnapshot" IS NOT NULL OR NEW."reviewSnapshotHash" IS NOT NULL THEN
            RAISE EXCEPTION 'A supplier direct shipment line must start pending review with zero receipts' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."version" <= OLD."version" THEN
        RAISE EXCEPTION 'Supplier direct shipment line version must increase on update' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW."id", NEW."shipmentId", NEW."lineNo", NEW."purchaseCommitmentLineId",
        NEW."quantity", NEW."physicalSnapshot", NEW."createdAt") IS DISTINCT FROM
       ROW(OLD."id", OLD."shipmentId", OLD."lineNo", OLD."purchaseCommitmentLineId",
        OLD."quantity", OLD."physicalSnapshot", OLD."createdAt") THEN
        RAISE EXCEPTION 'Supplier direct shipment line physical and source facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."receivedQuantity" < OLD."receivedQuantity" THEN
        RAISE EXCEPTION 'Supplier direct shipment line receipt quantity cannot decrease' USING ERRCODE = '23514';
    END IF;
    IF NEW."reviewStatus" = 'PENDING_REVIEW'
       AND (NEW."reviewedById" IS NOT NULL OR NEW."reviewedAt" IS NOT NULL
         OR NEW."reviewReason" IS NOT NULL OR NEW."checks" IS NOT NULL
         OR NEW."reviewSnapshot" IS NOT NULL OR NEW."reviewSnapshotHash" IS NOT NULL) THEN
        RAISE EXCEPTION 'Pending supplier direct shipment lines cannot carry a quality decision' USING ERRCODE = '23514';
    END IF;
    IF OLD."reviewStatus" IN ('APPROVED', 'REJECTED')
       AND ROW(NEW."reviewStatus", NEW."reviewedById", NEW."reviewedAt", NEW."reviewReason",
           NEW."checks", NEW."reviewSnapshot", NEW."reviewSnapshotHash", NEW."reviewEvidence") IS DISTINCT FROM
          ROW(OLD."reviewStatus", OLD."reviewedById", OLD."reviewedAt", OLD."reviewReason",
           OLD."checks", OLD."reviewSnapshot", OLD."reviewSnapshotHash", OLD."reviewEvidence") THEN
        RAISE EXCEPTION 'Supplier direct shipment quality decisions are immutable' USING ERRCODE = '23514';
    END IF;
    SELECT "status"::TEXT INTO v_head_status
      FROM "supplier_direct_shipments" WHERE "id" = NEW."shipmentId";
    IF NEW."reviewStatus" IS DISTINCT FROM OLD."reviewStatus"
       AND v_head_status <> 'PREPARED' THEN
        RAISE EXCEPTION 'Supplier direct quality decisions are only allowed while PREPARED' USING ERRCODE = '23514';
    END IF;
    IF NEW."serialClaimKey" IS DISTINCT FROM OLD."serialClaimKey"
       AND NEW."serialClaimKey" IS NOT NULL
       AND v_head_status <> 'PREPARED' THEN
        RAISE EXCEPTION 'A dispatched supplier direct serial claim cannot be changed' USING ERRCODE = '23514';
    END IF;
    IF NEW."serialClaimKey" IS DISTINCT FROM OLD."serialClaimKey"
       AND NEW."serialClaimKey" IS NULL
       AND v_head_status <> 'CANCELLED'
       AND NEW."reviewStatus" <> 'REJECTED' THEN
        RAISE EXCEPTION 'A serial claim may only be cleared by cancellation or rejection' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_supplier_direct_shipment_event_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION 'Supplier direct shipment events are append-only' USING ERRCODE = '23514';
    END IF;
    IF NEW."kind" = 'CREATE' OR NEW."kind" IN ('DISPATCH', 'CANCEL') THEN
        IF NEW."shipmentLineId" IS NOT NULL OR NEW."quantity" <> 0 THEN
            RAISE EXCEPTION 'Head supplier direct shipment events cannot carry a line or quantity' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."kind" IN ('APPROVE', 'REJECT') THEN
        IF NEW."shipmentLineId" IS NULL OR NEW."quantity" <> 0 THEN
            RAISE EXCEPTION 'Quality supplier direct shipment events must identify one line and have zero quantity' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."kind" = 'RECEIPT' THEN
        IF NEW."shipmentLineId" IS NULL OR NEW."quantity" <= 0 THEN
            RAISE EXCEPTION 'A supplier direct receipt event must identify one line and have positive quantity' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW."shipmentLineId" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM "supplier_direct_shipment_lines"
            WHERE "id" = NEW."shipmentLineId" AND "shipmentId" = NEW."shipmentId"
       ) THEN
        RAISE EXCEPTION 'Supplier direct shipment event line does not belong to its shipment' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protect_supplier_direct_shipment_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON "supplier_direct_shipments"
    FOR EACH ROW EXECUTE FUNCTION protect_supplier_direct_shipment_v11();

CREATE TRIGGER protect_supplier_direct_shipment_line_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON "supplier_direct_shipment_lines"
    FOR EACH ROW EXECUTE FUNCTION protect_supplier_direct_shipment_line_v11();

CREATE TRIGGER protect_supplier_direct_shipment_event_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON "supplier_direct_shipment_events"
    FOR EACH ROW EXECUTE FUNCTION protect_supplier_direct_shipment_event_v11();

CREATE OR REPLACE FUNCTION validate_supplier_direct_scope_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_shipment_id TEXT;
BEGIN
    IF TG_TABLE_NAME = 'supplier_direct_shipments' THEN
        v_shipment_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    ELSIF TG_TABLE_NAME = 'supplier_direct_shipment_lines' THEN
        v_shipment_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."shipmentId" ELSE NEW."shipmentId" END;
    ELSE
        v_shipment_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."shipmentId" ELSE NEW."shipmentId" END;
    END IF;
    PERFORM lock_supplier_direct_scope_v11(v_shipment_id);
    PERFORM assert_supplier_direct_head_integrity_v11(v_shipment_id);
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_direct_shipment_integrity_v11
    AFTER INSERT OR UPDATE ON "supplier_direct_shipments"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION validate_supplier_direct_scope_v11();

CREATE CONSTRAINT TRIGGER supplier_direct_shipment_line_integrity_v11
    AFTER INSERT OR UPDATE ON "supplier_direct_shipment_lines"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION validate_supplier_direct_scope_v11();

CREATE CONSTRAINT TRIGGER supplier_direct_shipment_event_integrity_v11
    AFTER INSERT ON "supplier_direct_shipment_events"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION validate_supplier_direct_scope_v11();

CREATE OR REPLACE FUNCTION validate_supplier_direct_purchase_line_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_pcl_id TEXT;
    v_shipment_id TEXT;
    v_direct_quantity BIGINT;
    v_prepared_quantity BIGINT;
    v_pcl RECORD;
BEGIN
    v_pcl_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    SELECT "quantity", "cancelledQuantity", "receivedQuantity", "directShippedQuantity"
      INTO v_pcl
      FROM "purchase_commitment_lines"
     WHERE "id" = v_pcl_id;
    IF FOUND THEN
        SELECT COALESCE(SUM(CASE WHEN s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED') THEN dl."quantity" ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN s."status" = 'PREPARED' AND dl."reviewStatus" <> 'REJECTED' THEN dl."quantity" ELSE 0 END), 0)
          INTO v_direct_quantity, v_prepared_quantity
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
         WHERE dl."purchaseCommitmentLineId" = v_pcl_id;
        IF v_direct_quantity <> v_pcl."directShippedQuantity" THEN
            RAISE EXCEPTION 'purchase commitment line % direct-shipped projection is inconsistent', v_pcl_id USING ERRCODE = '23514';
        END IF;
        IF v_pcl."cancelledQuantity"::BIGINT + v_pcl."receivedQuantity"::BIGINT + v_direct_quantity + v_prepared_quantity > v_pcl."quantity" THEN
            RAISE EXCEPTION 'purchase commitment line % direct plan exceeds available capacity', v_pcl_id USING ERRCODE = '23514';
        END IF;
    END IF;
    FOR v_shipment_id IN
        SELECT DISTINCT dl."shipmentId"
          FROM "supplier_direct_shipment_lines" dl
         WHERE dl."purchaseCommitmentLineId" = v_pcl_id
         ORDER BY dl."shipmentId"
    LOOP
        PERFORM assert_supplier_direct_head_integrity_v11(v_shipment_id);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_direct_purchase_line_integrity_v11
    AFTER INSERT OR UPDATE OR DELETE ON "purchase_commitment_lines"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION validate_supplier_direct_purchase_line_v11();

CREATE OR REPLACE FUNCTION validate_supplier_direct_purchase_commitment_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_pcl_id TEXT;
    v_shipment_id TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
        -- The PCL update is the real shared lock/version conflict.  It is
        -- intentionally performed in deterministic order and never writes a
        -- shipment head, so the PCL and head triggers cannot recurse.
        FOR v_pcl_id IN
            SELECT DISTINCT dl."purchaseCommitmentLineId"
              FROM "supplier_direct_shipment_lines" dl
              JOIN "purchase_commitments" pc ON pc.id = NEW."id"
             WHERE dl."purchaseCommitmentLineId" IN (
                 SELECT "id" FROM "purchase_commitment_lines" WHERE "purchaseCommitmentId" = NEW."id"
             )
             ORDER BY dl."purchaseCommitmentLineId"
        LOOP
            UPDATE "purchase_commitment_lines"
               SET "version" = "version" + 1
             WHERE "id" = v_pcl_id;
        END LOOP;
    END IF;

    FOR v_shipment_id IN
        SELECT DISTINCT dl."shipmentId"
          FROM "supplier_direct_shipment_lines" dl
          JOIN "purchase_commitment_lines" pcl ON pcl.id = dl."purchaseCommitmentLineId"
         WHERE pcl."purchaseCommitmentId" = NEW."id"
         ORDER BY dl."shipmentId"
    LOOP
        PERFORM assert_supplier_direct_head_integrity_v11(v_shipment_id);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_direct_purchase_commitment_integrity_v11
    AFTER UPDATE ON "purchase_commitments"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION validate_supplier_direct_purchase_commitment_v11();

CREATE OR REPLACE FUNCTION validate_supplier_direct_order_projection_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_shipment_id TEXT;
    v_expected_direct BIGINT;
    v_actual_direct BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        SELECT COALESCE(SUM(dl."quantity"), 0)
          INTO v_expected_direct
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
         WHERE s."orderId" = NEW."id"
           AND s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED');
        v_actual_direct := NEW."directShippedQuantity";
    ELSE
        SELECT COALESCE(SUM(dl."quantity"), 0)
          INTO v_expected_direct
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
          JOIN "purchase_commitment_lines" pcl ON pcl.id = dl."purchaseCommitmentLineId"
         WHERE pcl."orderLineId" = NEW."id"
           AND s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED');
        v_actual_direct := NEW."directShippedQuantity";
    END IF;
    IF v_expected_direct <> v_actual_direct THEN
        RAISE EXCEPTION 'Direct-shipped order projection is inconsistent' USING ERRCODE = '23514';
    END IF;
    FOR v_shipment_id IN
        SELECT DISTINCT s.id
          FROM "supplier_direct_shipments" s
          JOIN "supplier_direct_shipment_lines" dl ON dl."shipmentId" = s.id
          JOIN "purchase_commitment_lines" pcl ON pcl.id = dl."purchaseCommitmentLineId"
          JOIN "order_lines" ol ON ol.id = pcl."orderLineId"
         WHERE ol."orderId" = CASE WHEN TG_TABLE_NAME = 'orders' THEN NEW."id" ELSE NEW."orderId" END
         ORDER BY s.id
    LOOP
        PERFORM assert_supplier_direct_head_integrity_v11(v_shipment_id);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_direct_order_projection_integrity_v11
    AFTER UPDATE ON "orders"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION validate_supplier_direct_order_projection_v11();

CREATE CONSTRAINT TRIGGER supplier_direct_order_line_projection_integrity_v11
    AFTER UPDATE ON "order_lines"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION validate_supplier_direct_order_projection_v11();

-- Forward-migration preflight.  Existing databases must not acquire an
-- inferred direct shipment or a synthetic projection.  Any rows created by a
-- future command are checked by the same deferred functions above.
DO $$
DECLARE
    v_shipment_id TEXT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM "purchase_commitment_lines"
         WHERE ("fulfillmentMode" = 'STOCK_RECEIPT' AND "directShippedQuantity" <> 0)
            OR ("fulfillmentMode" = 'SUPPLIER_DIRECT' AND "receivedQuantity" <> 0)
    ) THEN
        RAISE EXCEPTION 'Existing purchase commitment lines violate direct/stock fulfillment exclusivity';
    END IF;
    IF EXISTS (SELECT 1 FROM "orders" WHERE "directShippedQuantity" <> 0)
       OR EXISTS (SELECT 1 FROM "order_lines" WHERE "directShippedQuantity" <> 0) THEN
        RAISE EXCEPTION 'Existing direct-shipped projections cannot be inferred by this migration';
    END IF;
    FOR v_shipment_id IN
        SELECT "id" FROM "supplier_direct_shipments" ORDER BY "id"
    LOOP
        PERFORM assert_supplier_direct_head_integrity_v11(v_shipment_id);
    END LOOP;
END;
$$;
