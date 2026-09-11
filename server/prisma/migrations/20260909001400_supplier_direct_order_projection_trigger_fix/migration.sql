-- Forward-only fix for 011.  The original trigger used a CASE expression
-- containing NEW.orderId for both trigger tables. PostgreSQL resolves record
-- fields while evaluating that statement, so an UPDATE on orders could fail
-- with 42703 before the CASE branch was selected.  Resolve the trigger row
-- through JSONB first; both trigger tables expose the required keys there.

CREATE OR REPLACE FUNCTION validate_supplier_direct_order_projection_v11()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_order_id TEXT;
    v_shipment_id TEXT;
    v_expected_direct BIGINT;
    v_actual_direct BIGINT;
    v_row JSONB;
BEGIN
    v_row := to_jsonb(NEW);
    v_order_id := CASE
        WHEN TG_TABLE_NAME = 'orders' THEN v_row->>'id'
        ELSE v_row->>'orderId'
    END;
    v_actual_direct := COALESCE((v_row->>'directShippedQuantity')::BIGINT, 0);

    IF TG_TABLE_NAME = 'orders' THEN
        SELECT COALESCE(SUM(dl."quantity"), 0)
          INTO v_expected_direct
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
         WHERE s."orderId" = v_order_id
           AND s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED');
    ELSE
        SELECT COALESCE(SUM(dl."quantity"), 0)
          INTO v_expected_direct
          FROM "supplier_direct_shipment_lines" dl
          JOIN "supplier_direct_shipments" s ON s.id = dl."shipmentId"
          JOIN "purchase_commitment_lines" pcl ON pcl.id = dl."purchaseCommitmentLineId"
         WHERE pcl."orderLineId" = v_order_id
           AND s."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED');
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

