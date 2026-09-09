-- A real row update serializes source-pool writers under READ COMMITTED and
-- invalidates stale SERIALIZABLE snapshots. SELECT FOR UPDATE alone does not
-- change the row version when two writers consume the same returned pool.
CREATE OR REPLACE FUNCTION assert_inventory_allocation_source(p_allocation_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_detail_id TEXT;
  v_quotation_line_id TEXT;
  v_receipt_line_id TEXT;
  v_return_hold_id TEXT;
  v_source_detail_id TEXT;
  v_source_quantity INTEGER;
  v_source_status TEXT;
  v_origin_order_line_id TEXT;
  v_origin_quotation_line_id TEXT;
  v_return_tx_id TEXT;
  v_return_tx_type TEXT;
  v_detail_stock_lot_key TEXT;
  v_used BIGINT;
BEGIN
  SELECT "inventoryDetailId", "quotationLineId", "stockReceiptLineId", "sourceReturnHoldId"
    INTO v_detail_id, v_quotation_line_id, v_receipt_line_id, v_return_hold_id
  FROM "inventory_allocations" WHERE "id" = p_allocation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- Serialize every source-pool check on the physical detail.  This makes
  -- concurrent source allocations conflict/re-read the same row even when
  -- the caller did not request SERIALIZABLE isolation.
  UPDATE "inventory_details" SET "quantity" = "quantity" WHERE "id" = v_detail_id;
  IF v_receipt_line_id IS NOT NULL AND v_return_hold_id IS NOT NULL THEN
    RAISE EXCEPTION '库存分配不能同时引用采购收货和退货池';
  END IF;
  IF v_receipt_line_id IS NULL AND v_return_hold_id IS NULL THEN
    SELECT "stockLotKey" INTO v_detail_stock_lot_key
    FROM "inventory_details" WHERE "id" = v_detail_id;
    IF v_detail_stock_lot_key IS DISTINCT FROM 'LEGACY' THEN
      RAISE EXCEPTION '收货来源库存不能省略采购收货或退货池来源: %', v_detail_id;
    END IF;
    RETURN;
  END IF;

  IF v_receipt_line_id IS NOT NULL THEN
    SELECT srl."inventoryDetailId", srl."quantity", srl."status"::TEXT,
           pcl."orderLineId", ol."quotationLineId"
      INTO v_source_detail_id, v_source_quantity, v_source_status,
           v_origin_order_line_id, v_origin_quotation_line_id
    FROM "stock_receipt_lines" srl
    JOIN "purchase_commitment_lines" pcl ON pcl."id" = srl."purchaseCommitmentLineId"
    JOIN "order_lines" ol ON ol."id" = pcl."orderLineId"
    WHERE srl."id" = v_receipt_line_id;
    IF NOT FOUND OR v_source_status IS DISTINCT FROM 'ACCEPTED'
      OR v_source_detail_id IS NULL OR v_source_detail_id IS DISTINCT FROM v_detail_id THEN
      RAISE EXCEPTION '采购库存分配必须引用同一实物的已验收收货行';
    END IF;
    IF v_quotation_line_id IS DISTINCT FROM v_origin_quotation_line_id THEN
      RAISE EXCEPTION '采购库存分配必须保留原采购订单行的报价行来源';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "allocation_assignments"
      WHERE "allocationId" = p_allocation_id AND "orderLineId" <> v_origin_order_line_id
    ) THEN
      RAISE EXCEPTION '采购收货库存只能分配给原采购订单行';
    END IF;
    SELECT COALESCE(SUM("allocatedQuantity"::BIGINT - "releasedQuantity"::BIGINT), 0)
      INTO v_used
    FROM "inventory_allocations"
    WHERE "stockReceiptLineId" = v_receipt_line_id;
    IF v_used > v_source_quantity THEN
      RAISE EXCEPTION '采购收货来源分配超过已验收数量: %', v_receipt_line_id;
    END IF;
    RETURN;
  END IF;

  SELECT rh."inventoryDetailId", rh."quantity", rh."status", rh."returnTransactionId",
         it."type"
    INTO v_source_detail_id, v_source_quantity, v_source_status, v_return_tx_id, v_return_tx_type
  FROM "return_holds" rh
  LEFT JOIN "inventory_transactions" it ON it."id" = rh."returnTransactionId"
  WHERE rh."id" = v_return_hold_id;
  IF NOT FOUND OR v_source_status IS DISTINCT FROM 'RELEASED'
    OR v_source_detail_id IS NULL OR v_source_detail_id IS DISTINCT FROM v_detail_id
    OR v_return_tx_id IS NULL OR v_return_tx_type IS DISTINCT FROM 'RETURN' THEN
    RAISE EXCEPTION '退货复售分配必须引用同一实物的已放行退货池';
  END IF;
  SELECT COALESCE(SUM("allocatedQuantity"::BIGINT - "releasedQuantity"::BIGINT), 0)
    INTO v_used
  FROM "inventory_allocations"
  WHERE "sourceReturnHoldId" = v_return_hold_id;
  IF v_used > v_source_quantity THEN
    RAISE EXCEPTION '退货复售分配超过已放行退货数量: %', v_return_hold_id;
  END IF;
END;
$$;
