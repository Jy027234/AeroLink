-- D13 forward guards: bind consumed quality review quantity to its OUTBOUND
-- source and keep Shipment.status derived from receipt counters.

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_status_value_check"
  CHECK ("status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED'));

CREATE OR REPLACE FUNCTION assert_shipment_line_row(line_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
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
  v_review_quantity INTEGER;
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
    fr."inventoryDetailId" AS review_detail_id, fr."quantity" AS review_quantity
  INTO v_order_line_id, v_assignment_id, v_outbound_transaction_id,
    v_quantity, v_received_quantity, v_returned_quantity,
    v_shipment_order_id, v_line_order_id, v_order_line_quantity,
    v_assignment_order_line_id, v_assignment_consumed_quantity,
    v_allocation_detail_id, v_outbound_type, v_outbound_quantity,
    v_outbound_order_id, v_outbound_detail_id, v_outbound_assignment_id,
    v_fulfillment_review_id, v_review_approved, v_review_consumed_at,
    v_review_assignment_id, v_review_order_id, v_review_detail_id,
    v_review_quantity
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
    OR v_review_detail_id IS DISTINCT FROM v_outbound_detail_id
    OR v_review_quantity IS NULL
    OR v_review_quantity::BIGINT <> ABS(v_outbound_quantity::BIGINT) THEN
    RAISE EXCEPTION 'Shipment line OUTBOUND must have an approved consumed review for its exact quantity';
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

CREATE OR REPLACE FUNCTION assert_shipment_status_row(shipment_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
  v_line_count BIGINT;
  v_total_quantity BIGINT;
  v_received_quantity BIGINT;
BEGIN
  SELECT s."status" INTO v_status
  FROM "shipments" s
  WHERE s."id" = shipment_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*),
    COALESCE(SUM("quantity"::BIGINT), 0),
    COALESCE(SUM("receivedQuantity"::BIGINT), 0)
  INTO v_line_count, v_total_quantity, v_received_quantity
  FROM "shipment_lines"
  WHERE "shipmentId" = shipment_id;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Shipment must contain at least one line';
  ELSIF v_status = 'DISPATCHED' AND v_received_quantity <> 0 THEN
    RAISE EXCEPTION 'DISPATCHED shipment cannot contain receipt quantity';
  ELSIF v_status = 'PARTIALLY_RECEIVED'
    AND (v_received_quantity <= 0 OR v_received_quantity >= v_total_quantity) THEN
    RAISE EXCEPTION 'PARTIALLY_RECEIVED shipment must have both received and outstanding quantity';
  ELSIF v_status = 'DELIVERED' AND v_received_quantity <> v_total_quantity THEN
    RAISE EXCEPTION 'DELIVERED shipment must have all lines fully received';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_shipment_line_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_shipment_line_row(NEW."id");
  PERFORM assert_shipment_status_row(NEW."shipmentId");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION assert_shipment_event_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shipmentLineId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "shipment_lines" WHERE "id" = NEW."shipmentLineId" AND "shipmentId" = NEW."shipmentId") THEN
    RAISE EXCEPTION 'Shipment event line does not belong to the shipment';
  END IF;
  IF NEW."shipmentLineId" IS NOT NULL THEN
    PERFORM assert_shipment_line_row(NEW."shipmentLineId");
  END IF;
  PERFORM assert_shipment_status_row(NEW."shipmentId");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION assert_shipment_status_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_shipment_status_row(NEW."id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER shipment_status_integrity
  AFTER INSERT OR UPDATE ON "shipments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_shipment_status_trigger();
