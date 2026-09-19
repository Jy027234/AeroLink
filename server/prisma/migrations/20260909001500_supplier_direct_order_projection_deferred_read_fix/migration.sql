-- Forward-only correction for 014.  Constraint triggers are deferred, so
-- NEW.directShippedQuantity can be the value from an earlier update in the
-- same transaction.  Re-read the final row state when the trigger fires.
-- Also keep the order-line row id separate from its parent order id: the
-- source aggregate is keyed by purchase_commitment_lines.orderLineId, while
-- the related-head check is keyed by the parent order id.

CREATE OR REPLACE FUNCTION validate_supplier_direct_order_projection_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_row JSONB;
    v_row_id TEXT;
    v_order_id TEXT;
    v_shipment_id TEXT;
    v_expected_direct BIGINT;
    v_actual_direct BIGINT;
BEGIN
    v_row := to_jsonb(NEW);
    v_row_id := v_row->>'id';

    IF TG_TABLE_NAME = 'orders' THEN
        v_order_id := v_row_id;
        SELECT o."directShippedQuantity"
          INTO v_actual_direct
          FROM "orders" o
         WHERE o.id = v_row_id;
        SELECT COALESCE(SUM(dl."quantity"), 0)
          INTO v_expected_direct
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
         WHERE s."orderId" = v_order_id
           AND s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED');
    ELSE
        SELECT ol."orderId", ol."directShippedQuantity"
          INTO v_order_id, v_actual_direct
          FROM "order_lines" ol
         WHERE ol.id = v_row_id;
        SELECT COALESCE(SUM(dl."quantity"), 0)
          INTO v_expected_direct
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
          JOIN "purchase_commitment_lines" pcl ON pcl.id = dl."purchaseCommitmentLineId"
         WHERE pcl."orderLineId" = v_row_id
           AND s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED');
    END IF;

    IF v_actual_direct IS NULL THEN
        RAISE EXCEPTION 'Direct-shipped projection row is missing' USING ERRCODE = '23514';
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
         WHERE ol."orderId" = v_order_id
         ORDER BY s.id
    LOOP
        PERFORM assert_supplier_direct_head_integrity_v11(v_shipment_id);
    END LOOP;
    RETURN NULL;
END;
$$;
