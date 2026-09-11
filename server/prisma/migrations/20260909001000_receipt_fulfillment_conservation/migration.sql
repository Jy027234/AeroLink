-- D14 receipt-owned fulfilment conservation.
--
-- 005-009 validate the physical receipt ledger and the allocation projection,
-- but they do not connect an OUTBOUND ledger row to the consumed counters on
-- its allocation and assignment.  They also allow a receipt-sourced parent
-- allocation with no origin-order assignment.  Keep this as a forward guard
-- so historical inconsistencies fail the migration instead of being repaired
-- or silently reinterpreted.

CREATE OR REPLACE FUNCTION assert_receipt_fulfillment_conservation_v10(p_detail_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_stock_lot_key TEXT;
  v_receipt_line_id TEXT;
  v_receipt_status TEXT;
  v_source_detail_id TEXT;
  v_origin_order_line_id TEXT;
  v_expected_quotation_line_id TEXT;
  v_allocation_id TEXT;
  v_assignment_id TEXT;
  v_allocation_receipt_line_id TEXT;
  v_allocation_quotation_line_id TEXT;
  v_parent_allocated BIGINT;
  v_parent_released BIGINT;
  v_parent_consumed BIGINT;
  v_parent_outbound BIGINT;
  v_assignment_count BIGINT;
  v_assigned BIGINT;
  v_released BIGINT;
  v_consumed BIGINT;
  v_assignment_outbound BIGINT;
BEGIN
  SELECT "stockLotKey"
    INTO v_stock_lot_key
  FROM "inventory_details"
  WHERE "id" = p_detail_id;
  IF NOT FOUND OR v_stock_lot_key IS NULL OR v_stock_lot_key = 'LEGACY' THEN
    RETURN;
  END IF;

  SELECT srl."id", srl."status"::TEXT, srl."inventoryDetailId", pcl."orderLineId", ol."quotationLineId"
    INTO v_receipt_line_id, v_receipt_status, v_source_detail_id,
         v_origin_order_line_id, v_expected_quotation_line_id
  FROM "stock_receipt_lines" srl
  JOIN "purchase_commitment_lines" pcl ON pcl."id" = srl."purchaseCommitmentLineId"
  JOIN "order_lines" ol ON ol."id" = pcl."orderLineId"
  WHERE srl."id" = v_stock_lot_key;
  IF NOT FOUND OR v_receipt_status IS DISTINCT FROM 'ACCEPTED'
    OR v_source_detail_id IS DISTINCT FROM p_detail_id THEN
    RAISE EXCEPTION '非 LEGACY 实物必须对应同一已验收收货来源: %', p_detail_id
      USING ERRCODE = '23514';
  END IF;

  FOR v_allocation_id IN
    SELECT ia."id"
    FROM "inventory_allocations" ia
    WHERE ia."inventoryDetailId" = p_detail_id
      AND (ia."stockReceiptLineId" IS NOT NULL OR ia."sourceReturnHoldId" IS NOT NULL)
    ORDER BY ia."id"
  LOOP
    SELECT ia."allocatedQuantity"::BIGINT, ia."releasedQuantity"::BIGINT,
           ia."consumedQuantity"::BIGINT, ia."quotationLineId",
           ia."stockReceiptLineId"
      INTO v_parent_allocated, v_parent_released, v_parent_consumed,
           v_allocation_quotation_line_id, v_allocation_receipt_line_id
    FROM "inventory_allocations" ia
    WHERE ia."id" = v_allocation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '采购收货分配在校验期间消失: %', v_allocation_id
        USING ERRCODE = '40001';
    END IF;
    IF v_allocation_receipt_line_id IS NOT NULL
      AND v_allocation_quotation_line_id IS DISTINCT FROM v_expected_quotation_line_id THEN
      RAISE EXCEPTION '采购收货分配必须保留原采购订单行报价来源: %', v_allocation_id
        USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*),
           COALESCE(SUM(aa."assignedQuantity"::BIGINT), 0),
           COALESCE(SUM(aa."releasedQuantity"::BIGINT), 0),
           COALESCE(SUM(aa."consumedQuantity"::BIGINT), 0)
      INTO v_assignment_count, v_assigned, v_released, v_consumed
    FROM "allocation_assignments" aa
    WHERE aa."allocationId" = v_allocation_id;
    -- An original purchase pool is never an unassigned stock bucket: every
    -- parent unit, including released history, must retain its origin-order
    -- assignment. A released return pool may be temporarily unassigned, but
    -- any assignments it does have still participate in conservation below.
    IF v_allocation_receipt_line_id IS NOT NULL AND v_assignment_count = 0 THEN
      RAISE EXCEPTION '采购收货分配必须至少绑定一个原采购订单行分配: %', v_allocation_id
        USING ERRCODE = '23514';
    END IF;
    IF (v_allocation_receipt_line_id IS NOT NULL
      AND v_assigned - v_released <> v_parent_allocated - v_parent_released)
      OR v_consumed <> v_parent_consumed THEN
      RAISE EXCEPTION '采购收货分配与订单行分配未守恒: %', v_allocation_id
        USING ERRCODE = '23514';
    END IF;
    IF v_allocation_receipt_line_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM "allocation_assignments" aa
      WHERE aa."allocationId" = v_allocation_id
        AND aa."orderLineId" IS DISTINCT FROM v_origin_order_line_id
    ) THEN
      RAISE EXCEPTION '采购收货分配只能绑定原采购订单行: %', v_allocation_id
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(-(it."quantity"::BIGINT)), 0)
      INTO v_parent_outbound
    FROM "inventory_transactions" it
    WHERE it."inventoryDetailId" = p_detail_id
      AND it."type" = 'OUTBOUND'
      AND it."allocationId" = v_allocation_id;
    IF v_parent_outbound <> v_parent_consumed THEN
      RAISE EXCEPTION '采购收货分配消费量与出库流水不一致: %', v_allocation_id
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "inventory_transactions" it
      WHERE it."inventoryDetailId" = p_detail_id
        AND it."type" = 'OUTBOUND'
        AND it."allocationId" = v_allocation_id
        AND NOT EXISTS (
          SELECT 1
          FROM "allocation_assignments" aa
          WHERE aa."id" = it."assignmentId"
            AND aa."allocationId" = v_allocation_id
        )
    ) THEN
      RAISE EXCEPTION '采购收货出库流水必须绑定同一分配的订单行分配: %', v_allocation_id
        USING ERRCODE = '23514';
    END IF;

    FOR v_assignment_id IN
      SELECT aa."id"
      FROM "allocation_assignments" aa
      WHERE aa."allocationId" = v_allocation_id
      ORDER BY aa."id"
    LOOP
      SELECT aa."consumedQuantity"::BIGINT
        INTO v_consumed
      FROM "allocation_assignments" aa
      WHERE aa."id" = v_assignment_id;
      SELECT COALESCE(SUM(-(it."quantity"::BIGINT)), 0)
        INTO v_assignment_outbound
      FROM "inventory_transactions" it
      WHERE it."inventoryDetailId" = p_detail_id
        AND it."type" = 'OUTBOUND'
        AND it."allocationId" = v_allocation_id
        AND it."assignmentId" = v_assignment_id;
      IF v_assignment_outbound <> v_consumed THEN
        RAISE EXCEPTION '采购订单行分配消费量与出库流水不一致: %', v_assignment_id
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION validate_receipt_fulfillment_conservation_v10()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_detail_id TEXT;
  v_old_detail_id TEXT;
  v_old_allocation_id TEXT;
  v_new_allocation_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'inventory_details' THEN
    IF TG_OP <> 'DELETE' THEN v_detail_id := NEW."id"; END IF;
    IF TG_OP <> 'INSERT' THEN v_old_detail_id := OLD."id"; END IF;
  ELSIF TG_TABLE_NAME = 'inventory_allocations' THEN
    IF TG_OP <> 'DELETE' THEN
      v_detail_id := NEW."inventoryDetailId";
      v_new_allocation_id := NEW."id";
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_detail_id := OLD."inventoryDetailId";
      v_old_allocation_id := OLD."id";
    END IF;
  ELSIF TG_TABLE_NAME = 'allocation_assignments' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_allocation_id := NEW."allocationId";
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_allocation_id := OLD."allocationId";
    END IF;
    IF v_new_allocation_id IS NOT NULL THEN
      SELECT "inventoryDetailId" INTO v_detail_id
      FROM "inventory_allocations" WHERE "id" = v_new_allocation_id;
    END IF;
    IF v_old_allocation_id IS NOT NULL THEN
      SELECT "inventoryDetailId" INTO v_old_detail_id
      FROM "inventory_allocations" WHERE "id" = v_old_allocation_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'inventory_transactions' THEN
    IF TG_OP <> 'DELETE' THEN v_detail_id := NEW."inventoryDetailId"; END IF;
    IF TG_OP <> 'INSERT' THEN v_old_detail_id := OLD."inventoryDetailId"; END IF;
  END IF;

  IF v_detail_id IS NOT NULL THEN
    PERFORM assert_receipt_fulfillment_conservation_v10(v_detail_id);
  END IF;
  IF v_old_detail_id IS NOT NULL AND v_old_detail_id IS DISTINCT FROM v_detail_id THEN
    PERFORM assert_receipt_fulfillment_conservation_v10(v_old_detail_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER receipt_fulfillment_detail_guard_v10
  AFTER INSERT OR UPDATE OR DELETE ON "inventory_details"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_receipt_fulfillment_conservation_v10();
CREATE CONSTRAINT TRIGGER receipt_fulfillment_allocation_guard_v10
  AFTER INSERT OR UPDATE OR DELETE ON "inventory_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_receipt_fulfillment_conservation_v10();
CREATE CONSTRAINT TRIGGER receipt_fulfillment_assignment_guard_v10
  AFTER INSERT OR UPDATE OR DELETE ON "allocation_assignments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_receipt_fulfillment_conservation_v10();
CREATE CONSTRAINT TRIGGER receipt_fulfillment_transaction_guard_v10
  AFTER INSERT OR UPDATE OR DELETE ON "inventory_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_receipt_fulfillment_conservation_v10();

-- Existing receipt-owned rows must already be internally coherent.  Do not
-- invent assignment or consumption facts during migration.
DO $$
DECLARE
  detail_id TEXT;
BEGIN
  FOR detail_id IN
    SELECT "id" FROM "inventory_details"
    WHERE "stockLotKey" <> 'LEGACY'
    ORDER BY "id"
  LOOP
    PERFORM assert_receipt_fulfillment_conservation_v10(detail_id);
  END LOOP;
END;
$$;
