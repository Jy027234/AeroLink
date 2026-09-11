-- Receipt identity remains an immutable source even before its first sale.
CREATE FUNCTION protect_received_item_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."partNumber", NEW."trackingType", NEW."unitOfMeasure") IS DISTINCT FROM
     ROW(OLD."partNumber", OLD."trackingType", OLD."unitOfMeasure")
    AND EXISTS (SELECT 1 FROM "inventory_details" WHERE "inventoryItemId" = OLD."id" AND "stockLotKey" <> 'LEGACY') THEN
    RAISE EXCEPTION '已验收采购库存的件号、追踪方式和单位不可改写';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER received_item_identity_guard BEFORE UPDATE ON "inventory_items"
  FOR EACH ROW EXECUTE FUNCTION protect_received_item_identity();

CREATE FUNCTION assert_receipt_outbound_links(detail_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "inventory_details" WHERE "id" = detail_id AND "stockLotKey" <> 'LEGACY') THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM "inventory_transactions" it
    WHERE it."inventoryDetailId" = detail_id AND it."type" = 'OUTBOUND'
      AND NOT EXISTS (
        SELECT 1 FROM "inventory_allocations" a
        JOIN "allocation_assignments" s ON s."allocationId" = a."id"
        JOIN "order_lines" ol ON ol."id" = s."orderLineId"
        JOIN "fulfillment_reviews" r ON r."assignmentId" = s."id"
        WHERE a."id" = it."allocationId" AND a."inventoryDetailId" = detail_id
          AND s."id" = it."assignmentId" AND ol."orderId" = it."orderId"
          AND r."id" = it."fulfillmentReviewId" AND r."inventoryDetailId" = detail_id
          AND r."orderId" = ol."orderId" AND r."approved" = true
          AND r."consumedAt" IS NOT NULL AND r."quantity"::BIGINT = -(it."quantity"::BIGINT)
      )
  ) THEN RAISE EXCEPTION '采购库存出库必须绑定同一分配、销售行和已消费质量复核'; END IF;
END;
$$;

-- An UPDATE can move an untagged OUTBOUND/RETURN away from a receipt detail.
-- Validate both sides so the original ledger cannot silently lose a fact.
CREATE OR REPLACE FUNCTION validate_inventory_transaction_receipt_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD."stockReceiptLineId" IS NOT NULL THEN PERFORM assert_stock_receipt_line_integrity(OLD."stockReceiptLineId"); END IF;
    PERFORM assert_inventory_detail_stock_lot(OLD."inventoryDetailId");
    PERFORM assert_inventory_detail_receipt_ledger(OLD."inventoryDetailId");
    PERFORM assert_receipt_outbound_links(OLD."inventoryDetailId");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW."stockReceiptLineId" IS NOT NULL THEN
      PERFORM assert_inventory_transaction_source(NEW."id");
      PERFORM assert_stock_receipt_line_integrity(NEW."stockReceiptLineId");
    END IF;
    PERFORM assert_inventory_detail_stock_lot(NEW."inventoryDetailId");
    PERFORM assert_inventory_detail_receipt_ledger(NEW."inventoryDetailId");
    PERFORM assert_receipt_outbound_links(NEW."inventoryDetailId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_receipt_review_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM assert_receipt_outbound_links(OLD."inventoryDetailId"); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_receipt_outbound_links(NEW."inventoryDetailId"); END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER receipt_outbound_review_link_guard AFTER INSERT OR UPDATE OR DELETE ON "fulfillment_reviews"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_receipt_review_links();
