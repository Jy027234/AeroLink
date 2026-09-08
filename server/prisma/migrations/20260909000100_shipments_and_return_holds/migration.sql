-- D13 modern shipment, receipt, and quarantined return facts.
-- The legacy shipment_tracking/tracking_events tables remain untouched.

ALTER TABLE "inventory_transactions"
  ADD COLUMN "fulfillmentReviewId" TEXT;

CREATE UNIQUE INDEX "inventory_transactions_fulfillmentReviewId_key"
  ON "inventory_transactions"("fulfillmentReviewId");

CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shipmentNumber" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISPATCHED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "evidence" JSONB NOT NULL,
    "commandId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shipment_lines" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "outboundTransactionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "returnedQuantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "identitySnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shipment_events" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "shipmentLineId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "eventNo" INTEGER NOT NULL,
    "actorId" TEXT,
    "evidence" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "return_holds" (
    "id" TEXT NOT NULL,
    "shipmentLineId" TEXT NOT NULL,
    "inventoryDetailId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUARANTINED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "identitySnapshot" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commandId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseCommandId" TEXT,
    "releaseRequestHash" TEXT,
    "releaseEvidence" JSONB,
    "releaseReason" TEXT,
    "returnTransactionId" TEXT,

    CONSTRAINT "return_holds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "return_events" (
    "id" TEXT NOT NULL,
    "returnHoldId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "eventNo" INTEGER NOT NULL,
    "actorId" TEXT,
    "evidence" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipments_shipmentNumber_key" ON "shipments"("shipmentNumber");
CREATE UNIQUE INDEX "shipments_commandId_key" ON "shipments"("commandId");
CREATE INDEX "shipments_orderId_idx" ON "shipments"("orderId");
CREATE INDEX "shipments_createdById_idx" ON "shipments"("createdById");
CREATE INDEX "shipments_status_createdAt_idx" ON "shipments"("status", "createdAt");

CREATE UNIQUE INDEX "shipment_lines_shipmentId_lineNo_key" ON "shipment_lines"("shipmentId", "lineNo");
CREATE INDEX "shipment_lines_orderLineId_idx" ON "shipment_lines"("orderLineId");
CREATE INDEX "shipment_lines_assignmentId_idx" ON "shipment_lines"("assignmentId");
CREATE INDEX "shipment_lines_outboundTransactionId_idx" ON "shipment_lines"("outboundTransactionId");

CREATE UNIQUE INDEX "shipment_events_commandId_eventNo_key" ON "shipment_events"("commandId", "eventNo");
CREATE INDEX "shipment_events_shipmentId_createdAt_idx" ON "shipment_events"("shipmentId", "createdAt");
CREATE INDEX "shipment_events_shipmentLineId_createdAt_idx" ON "shipment_events"("shipmentLineId", "createdAt");
CREATE INDEX "shipment_events_actorId_createdAt_idx" ON "shipment_events"("actorId", "createdAt");

CREATE UNIQUE INDEX "return_holds_commandId_key" ON "return_holds"("commandId");
CREATE UNIQUE INDEX "return_holds_releaseCommandId_key" ON "return_holds"("releaseCommandId");
CREATE UNIQUE INDEX "return_holds_returnTransactionId_key" ON "return_holds"("returnTransactionId");
CREATE INDEX "return_holds_shipmentLineId_idx" ON "return_holds"("shipmentLineId");
CREATE INDEX "return_holds_inventoryDetailId_idx" ON "return_holds"("inventoryDetailId");
CREATE INDEX "return_holds_receivedById_idx" ON "return_holds"("receivedById");
CREATE INDEX "return_holds_releasedById_idx" ON "return_holds"("releasedById");
CREATE INDEX "return_holds_status_receivedAt_idx" ON "return_holds"("status", "receivedAt");

CREATE UNIQUE INDEX "return_events_commandId_eventNo_key" ON "return_events"("commandId", "eventNo");
CREATE INDEX "return_events_returnHoldId_createdAt_idx" ON "return_events"("returnHoldId", "createdAt");
CREATE INDEX "return_events_actorId_createdAt_idx" ON "return_events"("actorId", "createdAt");

ALTER TABLE "inventory_transactions"
  ADD CONSTRAINT "inventory_transactions_fulfillmentReviewId_fkey"
  FOREIGN KEY ("fulfillmentReviewId") REFERENCES "fulfillment_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipments_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipment_lines"
  ADD CONSTRAINT "shipment_lines_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipment_lines_orderLineId_fkey"
  FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipment_lines_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "allocation_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipment_lines_outboundTransactionId_fkey"
  FOREIGN KEY ("outboundTransactionId") REFERENCES "inventory_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipment_events"
  ADD CONSTRAINT "shipment_events_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipment_events_shipmentLineId_fkey"
  FOREIGN KEY ("shipmentLineId") REFERENCES "shipment_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipment_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "return_holds"
  ADD CONSTRAINT "return_holds_shipmentLineId_fkey"
  FOREIGN KEY ("shipmentLineId") REFERENCES "shipment_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "return_holds_inventoryDetailId_fkey"
  FOREIGN KEY ("inventoryDetailId") REFERENCES "inventory_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "return_holds_receivedById_fkey"
  FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "return_holds_releasedById_fkey"
  FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "return_holds_returnTransactionId_fkey"
  FOREIGN KEY ("returnTransactionId") REFERENCES "inventory_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "return_events"
  ADD CONSTRAINT "return_events_returnHoldId_fkey"
  FOREIGN KEY ("returnHoldId") REFERENCES "return_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "return_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipments" ADD CONSTRAINT "shipments_quantity_version_check"
  CHECK ("version" > 0 AND length(btrim("status")) > 0);
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_quantity_range_check"
  CHECK ("quantity" > 0 AND "receivedQuantity" >= 0 AND "returnedQuantity" >= 0
    AND "receivedQuantity" <= "quantity" AND "returnedQuantity" <= "quantity" AND "version" > 0
    AND "lineNo" > 0);
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_quantity_check"
  CHECK ("quantity" > 0 AND "eventNo" > 0 AND length(btrim("kind")) > 0);
ALTER TABLE "return_holds" ADD CONSTRAINT "return_holds_quantity_status_check"
  CHECK ("quantity" > 0 AND "version" > 0 AND "status" IN ('QUARANTINED', 'RELEASED'));
ALTER TABLE "return_events" ADD CONSTRAINT "return_events_quantity_check"
  CHECK ("quantity" > 0 AND "eventNo" > 0 AND length(btrim("kind")) > 0);

-- Source facts and event rows are append-only. Counters can only move forward
-- through a versioned update, and a ReturnHold has exactly one release edge.
CREATE FUNCTION protect_shipment_return_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'return_holds'
      AND (NEW."status" <> 'QUARANTINED'
        OR NEW."version" <> 1
        OR NEW."releasedById" IS NOT NULL OR NEW."releasedAt" IS NOT NULL
        OR NEW."releaseCommandId" IS NOT NULL OR NEW."releaseRequestHash" IS NOT NULL
        OR NEW."releaseEvidence" IS NOT NULL OR NEW."releaseReason" IS NOT NULL
        OR NEW."returnTransactionId" IS NOT NULL) THEN
      RAISE EXCEPTION 'Return hold must be created as an unreleased quarantine record';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shipment and return history cannot be deleted';
  END IF;

  IF TG_TABLE_NAME = 'shipment_events' OR TG_TABLE_NAME = 'return_events' THEN
    RAISE EXCEPTION 'Shipment and return events cannot be updated';
  ELSIF TG_TABLE_NAME = 'shipments' THEN
    IF ROW(NEW."id", NEW."orderId", NEW."shipmentNumber", NEW."carrier", NEW."trackingNumber",
      NEW."origin", NEW."destination", NEW."commandId", NEW."requestHash", NEW."createdById",
      NEW."shippedAt", NEW."createdAt", NEW."evidence") IS DISTINCT FROM
      ROW(OLD."id", OLD."orderId", OLD."shipmentNumber", OLD."carrier", OLD."trackingNumber",
      OLD."origin", OLD."destination", OLD."commandId", OLD."requestHash", OLD."createdById",
      OLD."shippedAt", OLD."createdAt", OLD."evidence") THEN
      RAISE EXCEPTION 'Shipment source facts cannot be replaced';
    END IF;
    IF NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'Shipment version must increase';
    END IF;
  ELSIF TG_TABLE_NAME = 'shipment_lines' THEN
    IF ROW(NEW."id", NEW."shipmentId", NEW."lineNo", NEW."orderLineId", NEW."assignmentId",
      NEW."outboundTransactionId", NEW."quantity", NEW."identitySnapshot", NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id", OLD."shipmentId", OLD."lineNo", OLD."orderLineId", OLD."assignmentId",
      OLD."outboundTransactionId", OLD."quantity", OLD."identitySnapshot", OLD."createdAt") THEN
      RAISE EXCEPTION 'Shipment line source facts cannot be replaced';
    END IF;
    IF NEW."receivedQuantity" < OLD."receivedQuantity"
      OR NEW."returnedQuantity" < OLD."returnedQuantity"
      OR NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'Shipment line counters must be monotonic and versioned';
    END IF;
  ELSIF TG_TABLE_NAME = 'return_holds' THEN
    IF ROW(NEW."id", NEW."shipmentLineId", NEW."inventoryDetailId", NEW."quantity", NEW."identitySnapshot",
      NEW."evidence", NEW."snapshotHash", NEW."receivedById", NEW."receivedAt", NEW."commandId",
      NEW."requestHash") IS DISTINCT FROM
      ROW(OLD."id", OLD."shipmentLineId", OLD."inventoryDetailId", OLD."quantity", OLD."identitySnapshot",
      OLD."evidence", OLD."snapshotHash", OLD."receivedById", OLD."receivedAt", OLD."commandId",
      OLD."requestHash") THEN
      RAISE EXCEPTION 'Return hold source and receipt facts cannot be replaced';
    END IF;
    IF OLD."status" = 'RELEASED' THEN
      RAISE EXCEPTION 'Released return hold cannot be changed';
    END IF;
    IF NEW."status" = 'QUARANTINED' THEN
      IF NEW."version" <> OLD."version"
        OR NEW."releasedById" IS NOT NULL OR NEW."releasedAt" IS NOT NULL
        OR NEW."releaseCommandId" IS NOT NULL OR NEW."releaseRequestHash" IS NOT NULL
        OR NEW."releaseEvidence" IS NOT NULL OR NEW."releaseReason" IS NOT NULL
        OR NEW."returnTransactionId" IS NOT NULL THEN
        RAISE EXCEPTION 'Quarantined return hold cannot carry release facts';
      END IF;
    ELSIF NEW."status" = 'RELEASED' THEN
      IF OLD."status" <> 'QUARANTINED' OR NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'Return hold can be released only once with the next version';
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid return hold status transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shipment_history_guard BEFORE UPDATE OR DELETE ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION protect_shipment_return_history();
CREATE TRIGGER shipment_line_history_guard BEFORE UPDATE OR DELETE ON "shipment_lines"
  FOR EACH ROW EXECUTE FUNCTION protect_shipment_return_history();
CREATE TRIGGER shipment_event_history_guard BEFORE UPDATE OR DELETE ON "shipment_events"
  FOR EACH ROW EXECUTE FUNCTION protect_shipment_return_history();
CREATE TRIGGER return_hold_history_guard BEFORE INSERT OR UPDATE OR DELETE ON "return_holds"
  FOR EACH ROW EXECUTE FUNCTION protect_shipment_return_history();
CREATE TRIGGER return_event_history_guard BEFORE UPDATE OR DELETE ON "return_events"
  FOR EACH ROW EXECUTE FUNCTION protect_shipment_return_history();

CREATE FUNCTION assert_shipment_line_row(line_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_order_line_id TEXT;
  v_assignment_id TEXT;
  v_outbound_transaction_id TEXT;
  v_quantity INTEGER;
  v_received_quantity INTEGER;
  v_returned_quantity INTEGER;
  v_shipment_order_id TEXT;
  v_line_order_id TEXT;
  v_order_line_quantity INTEGER;
  v_assignment_order_line_id TEXT;
  v_assignment_consumed_quantity INTEGER;
  v_allocation_detail_id TEXT;
  v_outbound_type TEXT;
  v_outbound_quantity INTEGER;
  v_outbound_order_id TEXT;
  v_outbound_detail_id TEXT;
  v_outbound_assignment_id TEXT;
  v_fulfillment_review_id TEXT;
  v_review_approved BOOLEAN;
  v_review_consumed_at TIMESTAMP(3);
  v_review_assignment_id TEXT;
  v_review_order_id TEXT;
  v_review_detail_id TEXT;
  outbound_total BIGINT;
  order_line_total BIGINT;
  receipt_total BIGINT;
  return_total BIGINT;
BEGIN
  SELECT sl."orderLineId", sl."assignmentId", sl."outboundTransactionId",
    sl."quantity", sl."receivedQuantity", sl."returnedQuantity",
    s."orderId" AS shipment_order_id,
    ol."orderId" AS line_order_id, ol."quantity" AS order_line_quantity,
    a."orderLineId" AS assignment_order_line_id, a."consumedQuantity" AS assignment_consumed_quantity,
    al."inventoryDetailId" AS allocation_detail_id,
    t."type" AS outbound_type, t."quantity" AS outbound_quantity, t."orderId" AS outbound_order_id,
    t."inventoryDetailId" AS outbound_detail_id, t."assignmentId" AS outbound_assignment_id,
    t."fulfillmentReviewId" AS fulfillment_review_id,
    fr."approved" AS review_approved, fr."consumedAt" AS review_consumed_at,
    fr."assignmentId" AS review_assignment_id, fr."orderId" AS review_order_id,
    fr."inventoryDetailId" AS review_detail_id
  INTO v_order_line_id, v_assignment_id, v_outbound_transaction_id,
    v_quantity, v_received_quantity, v_returned_quantity,
    v_shipment_order_id, v_line_order_id, v_order_line_quantity,
    v_assignment_order_line_id, v_assignment_consumed_quantity,
    v_allocation_detail_id, v_outbound_type, v_outbound_quantity,
    v_outbound_order_id, v_outbound_detail_id, v_outbound_assignment_id,
    v_fulfillment_review_id, v_review_approved, v_review_consumed_at,
    v_review_assignment_id, v_review_order_id, v_review_detail_id
  FROM "shipment_lines" sl
  JOIN "shipments" s ON s."id" = sl."shipmentId"
  JOIN "order_lines" ol ON ol."id" = sl."orderLineId"
  JOIN "allocation_assignments" a ON a."id" = sl."assignmentId"
  JOIN "inventory_allocations" al ON al."id" = a."allocationId"
  JOIN "inventory_transactions" t ON t."id" = sl."outboundTransactionId"
  LEFT JOIN "fulfillment_reviews" fr ON fr."id" = t."fulfillmentReviewId"
  WHERE sl."id" = line_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_shipment_order_id IS DISTINCT FROM v_line_order_id
    OR v_assignment_order_line_id IS DISTINCT FROM v_order_line_id THEN
    RAISE EXCEPTION 'Shipment line order and assignment chain is inconsistent';
  END IF;
  IF v_outbound_type IS DISTINCT FROM 'OUTBOUND' OR v_outbound_quantity >= 0
    OR v_outbound_order_id IS DISTINCT FROM v_shipment_order_id
    OR v_outbound_detail_id IS DISTINCT FROM v_allocation_detail_id
    OR v_outbound_assignment_id IS DISTINCT FROM v_assignment_id THEN
    RAISE EXCEPTION 'Shipment line must select its matching negative OUTBOUND transaction';
  END IF;
  IF v_fulfillment_review_id IS NULL
    OR v_review_approved IS DISTINCT FROM TRUE
    OR v_review_consumed_at IS NULL
    OR v_review_assignment_id IS DISTINCT FROM v_assignment_id
    OR v_review_order_id IS DISTINCT FROM v_shipment_order_id
    OR v_review_detail_id IS DISTINCT FROM v_outbound_detail_id THEN
    RAISE EXCEPTION 'Shipment line OUTBOUND must have its approved consumed fulfillment review';
  END IF;
  IF v_quantity > v_order_line_quantity
    OR v_quantity > v_assignment_consumed_quantity THEN
    RAISE EXCEPTION 'Shipment line quantity exceeds order line or assignment outbound quantity';
  END IF;

  SELECT COALESCE(SUM("quantity"), 0) INTO outbound_total
  FROM "shipment_lines"
  WHERE "outboundTransactionId" = v_outbound_transaction_id;
  IF outbound_total > ABS(v_outbound_quantity::BIGINT) THEN
    RAISE EXCEPTION 'Shipment lines exceed their OUTBOUND transaction quantity';
  END IF;
  SELECT COALESCE(SUM("quantity"), 0) INTO order_line_total
  FROM "shipment_lines"
  WHERE "orderLineId" = v_order_line_id;
  IF order_line_total > v_order_line_quantity THEN
    RAISE EXCEPTION 'Shipment lines exceed the order line quantity';
  END IF;
  SELECT COALESCE(SUM("quantity"), 0) INTO receipt_total
  FROM "shipment_events"
  WHERE "shipmentLineId" = line_id AND UPPER("kind") IN ('RECEIPT', 'RECEIVED');
  IF receipt_total <> v_received_quantity THEN
    RAISE EXCEPTION 'Shipment line receipt counter does not match receipt events';
  END IF;
  SELECT COALESCE(SUM("quantity"), 0) INTO return_total
  FROM "return_holds" WHERE "shipmentLineId" = line_id;
  IF return_total <> v_returned_quantity THEN
    RAISE EXCEPTION 'Shipment line return counter does not match return holds';
  END IF;
END;
$$;

CREATE FUNCTION assert_return_hold_row(hold_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_shipment_line_id TEXT;
  v_inventory_detail_id TEXT;
  v_quantity INTEGER;
  v_status TEXT;
  v_line_quantity INTEGER;
  v_assignment_id TEXT;
  v_shipment_order_id TEXT;
  v_allocation_detail_id TEXT;
  v_return_type TEXT;
  v_return_quantity INTEGER;
  v_return_detail_id TEXT;
  v_return_order_id TEXT;
  v_return_assignment_id TEXT;
  v_return_fulfillment_review_id TEXT;
  v_released_by_id TEXT;
  v_released_at TIMESTAMP(3);
  v_release_command_id TEXT;
  v_release_request_hash TEXT;
  v_release_evidence JSONB;
  v_release_reason TEXT;
  v_return_transaction_id TEXT;
  returned_total BIGINT;
BEGIN
  SELECT rh."shipmentLineId", rh."inventoryDetailId", rh."quantity", rh."status",
    sl."quantity" AS line_quantity, sl."assignmentId", s."orderId" AS shipment_order_id,
    al."inventoryDetailId" AS allocation_detail_id, rh."releasedById", rh."releasedAt",
    rh."releaseCommandId", rh."releaseRequestHash", rh."releaseEvidence", rh."releaseReason",
    rh."returnTransactionId"
  INTO v_shipment_line_id, v_inventory_detail_id, v_quantity, v_status,
    v_line_quantity, v_assignment_id, v_shipment_order_id, v_allocation_detail_id,
    v_released_by_id, v_released_at, v_release_command_id, v_release_request_hash,
    v_release_evidence, v_release_reason, v_return_transaction_id
  FROM "return_holds" rh
  JOIN "shipment_lines" sl ON sl."id" = rh."shipmentLineId"
  JOIN "shipments" s ON s."id" = sl."shipmentId"
  JOIN "allocation_assignments" a ON a."id" = sl."assignmentId"
  JOIN "inventory_allocations" al ON al."id" = a."allocationId"
  WHERE rh."id" = hold_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_inventory_detail_id IS DISTINCT FROM v_allocation_detail_id THEN
    RAISE EXCEPTION 'Return hold detail does not match the outbound allocation source';
  END IF;
  IF v_quantity > v_line_quantity THEN
    RAISE EXCEPTION 'Return hold quantity exceeds shipment line quantity';
  END IF;
  SELECT COALESCE(SUM("quantity"), 0) INTO returned_total
  FROM "return_holds"
  WHERE "shipmentLineId" = v_shipment_line_id;
  IF returned_total > v_line_quantity THEN
    RAISE EXCEPTION 'Return holds exceed shipment line quantity';
  END IF;

  IF v_status = 'RELEASED' THEN
    IF v_released_by_id IS NULL OR v_released_at IS NULL
      OR v_release_command_id IS NULL OR v_release_request_hash IS NULL
      OR v_release_evidence IS NULL OR v_release_reason IS NULL
      OR v_return_transaction_id IS NULL THEN
      RAISE EXCEPTION 'Released return hold is missing release facts';
    END IF;
    SELECT t."type", t."quantity", t."inventoryDetailId", t."orderId", t."assignmentId",
      t."fulfillmentReviewId"
    INTO v_return_type, v_return_quantity, v_return_detail_id,
      v_return_order_id, v_return_assignment_id, v_return_fulfillment_review_id
    FROM "return_holds" rh
    JOIN "inventory_transactions" t ON t."id" = rh."returnTransactionId"
    WHERE rh."id" = hold_id;
    IF NOT FOUND OR v_return_type IS DISTINCT FROM 'RETURN'
      OR v_return_quantity <= 0
      OR v_return_quantity <> v_quantity
      OR v_return_detail_id IS DISTINCT FROM v_inventory_detail_id
      OR v_return_order_id IS DISTINCT FROM v_shipment_order_id
      OR v_return_assignment_id IS DISTINCT FROM v_assignment_id
      OR v_return_fulfillment_review_id IS NOT NULL THEN
      RAISE EXCEPTION 'Released return hold must have one matching positive RETURN transaction';
    END IF;
  ELSE
    IF v_released_by_id IS NOT NULL OR v_released_at IS NOT NULL
      OR v_release_command_id IS NOT NULL OR v_release_request_hash IS NOT NULL
      OR v_release_evidence IS NOT NULL OR v_release_reason IS NOT NULL
      OR v_return_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'Quarantined return hold cannot carry release facts';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION assert_shipment_event_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shipmentLineId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "shipment_lines" WHERE "id" = NEW."shipmentLineId" AND "shipmentId" = NEW."shipmentId") THEN
    RAISE EXCEPTION 'Shipment event line does not belong to the shipment';
  END IF;
  IF NEW."shipmentLineId" IS NOT NULL THEN
    PERFORM assert_shipment_line_row(NEW."shipmentLineId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_shipment_line_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_shipment_line_row(NEW."id");
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_return_hold_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_return_hold_row(NEW."id");
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_return_event_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_return_hold_row(NEW."returnHoldId");
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_shipment_source_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_id TEXT;
  hold_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'inventory_transactions' THEN
    FOR line_id IN SELECT "id" FROM "shipment_lines"
      WHERE "outboundTransactionId" = NEW."id" LOOP
      PERFORM assert_shipment_line_row(line_id);
    END LOOP;
    FOR hold_id IN SELECT "id" FROM "return_holds"
      WHERE "returnTransactionId" = NEW."id" LOOP
      PERFORM assert_return_hold_row(hold_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'order_lines' THEN
    FOR line_id IN SELECT "id" FROM "shipment_lines" WHERE "orderLineId" = NEW."id" LOOP
      PERFORM assert_shipment_line_row(line_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'allocation_assignments' THEN
    FOR line_id IN SELECT "id" FROM "shipment_lines" WHERE "assignmentId" = NEW."id" LOOP
      PERFORM assert_shipment_line_row(line_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'inventory_allocations' THEN
    FOR line_id IN
      SELECT sl."id" FROM "shipment_lines" sl
      JOIN "allocation_assignments" a ON a."id" = sl."assignmentId"
      WHERE a."allocationId" = NEW."id"
    LOOP
      PERFORM assert_shipment_line_row(line_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'fulfillment_reviews' THEN
    FOR line_id IN
      SELECT sl."id" FROM "shipment_lines" sl
      JOIN "inventory_transactions" t ON t."id" = sl."outboundTransactionId"
      WHERE t."fulfillmentReviewId" = NEW."id"
    LOOP
      PERFORM assert_shipment_line_row(line_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER shipment_line_integrity
  AFTER INSERT OR UPDATE ON "shipment_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_line_trigger();
CREATE CONSTRAINT TRIGGER shipment_event_integrity
  AFTER INSERT ON "shipment_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_event_row();
CREATE CONSTRAINT TRIGGER return_hold_integrity
  AFTER INSERT OR UPDATE ON "return_holds"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_return_hold_trigger();
CREATE CONSTRAINT TRIGGER return_event_integrity
  AFTER INSERT ON "return_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_return_event_row();
CREATE CONSTRAINT TRIGGER inventory_transaction_shipment_integrity
  AFTER INSERT OR UPDATE ON "inventory_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_source_dependency();
CREATE CONSTRAINT TRIGGER order_line_shipment_integrity
  AFTER UPDATE ON "order_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_source_dependency();
CREATE CONSTRAINT TRIGGER assignment_shipment_integrity
  AFTER UPDATE ON "allocation_assignments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_source_dependency();
CREATE CONSTRAINT TRIGGER allocation_shipment_integrity
  AFTER UPDATE ON "inventory_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_source_dependency();
CREATE CONSTRAINT TRIGGER fulfillment_review_shipment_integrity
  AFTER UPDATE ON "fulfillment_reviews"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_source_dependency();
