-- D14 stock receipt and physical-source provenance.
--
-- A receipt is an arrival fact for one purchase commitment.  Receipt lines
-- are immutable physical batches/serial units whose review status may move
-- once from PENDING_REVIEW to ACCEPTED or REJECTED.  No historical receipt or
-- allocation is inferred here: the nullable provenance columns remain NULL
-- for legacy rows until a later, explicit receiving command creates a source.

CREATE TYPE "StockReceiptLineStatus" AS ENUM (
  'PENDING_REVIEW',
  'ACCEPTED',
  'REJECTED'
);

CREATE TABLE "stock_receipts" (
  "id" TEXT NOT NULL,
  "purchaseCommitmentId" TEXT NOT NULL,
  "receiptNumber" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "receivedById" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supplierDeliveryReference" TEXT NOT NULL,
  "reason" TEXT,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stock_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_receipt_lines" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "purchaseCommitmentLineId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "status" "StockReceiptLineStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "identitySnapshot" JSONB NOT NULL,
  "qualitySnapshot" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewReason" TEXT,
  "inventoryDetailId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stock_receipt_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_receipt_events" (
  "id" TEXT NOT NULL,
  "stockReceiptId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "commandId" TEXT NOT NULL,
  "eventNo" INTEGER NOT NULL,
  "requestHash" TEXT NOT NULL,
  "actorId" TEXT,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_receipt_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "inventory_transactions"
  ADD COLUMN "stockReceiptLineId" TEXT;

ALTER TABLE "inventory_allocations"
  ADD COLUMN "stockReceiptLineId" TEXT,
  ADD COLUMN "sourceReturnHoldId" TEXT;

-- Keep historical/manual details in the shared LEGACY lot while giving each
-- accepted receipt its own immutable lot key.  This allows two arrivals with
-- the same part/batch/condition/warehouse tuple to retain independent QC and
-- cost/source provenance.
ALTER TABLE "inventory_details"
  ADD COLUMN "stockLotKey" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD CONSTRAINT "inventory_details_stock_lot_key_nonblank"
    CHECK (length(btrim("stockLotKey")) > 0);

DROP INDEX "inventory_details_inventoryItemId_batchNumber_conditionCode_key";
CREATE UNIQUE INDEX "inventory_details_inventoryItemId_batchNumber_conditionCode_key"
  ON "inventory_details"("inventoryItemId", "batchNumber", "conditionCode", "warehouse", "stockLotKey");

CREATE UNIQUE INDEX "stock_receipts_receiptNumber_key"
  ON "stock_receipts"("receiptNumber");
CREATE UNIQUE INDEX "stock_receipts_commandId_key"
  ON "stock_receipts"("commandId");
CREATE UNIQUE INDEX "stock_receipts_purchaseCommitmentId_supplierDeliveryReference_key"
  ON "stock_receipts"("purchaseCommitmentId", "supplierDeliveryReference");
CREATE INDEX "stock_receipts_purchaseCommitmentId_receivedAt_idx"
  ON "stock_receipts"("purchaseCommitmentId", "receivedAt");
CREATE INDEX "stock_receipts_receivedById_receivedAt_idx"
  ON "stock_receipts"("receivedById", "receivedAt");

CREATE UNIQUE INDEX "stock_receipt_lines_receiptId_lineNo_key"
  ON "stock_receipt_lines"("receiptId", "lineNo");
CREATE UNIQUE INDEX "stock_receipt_lines_inventoryDetailId_key"
  ON "stock_receipt_lines"("inventoryDetailId");
CREATE INDEX "stock_receipt_lines_purchaseCommitmentLineId_idx"
  ON "stock_receipt_lines"("purchaseCommitmentLineId");
CREATE INDEX "stock_receipt_lines_inventoryDetailId_idx"
  ON "stock_receipt_lines"("inventoryDetailId");
CREATE INDEX "stock_receipt_lines_status_reviewedAt_idx"
  ON "stock_receipt_lines"("status", "reviewedAt");

CREATE UNIQUE INDEX "stock_receipt_events_commandId_eventNo_key"
  ON "stock_receipt_events"("commandId", "eventNo");
CREATE INDEX "stock_receipt_events_stockReceiptId_createdAt_idx"
  ON "stock_receipt_events"("stockReceiptId", "createdAt");
CREATE INDEX "stock_receipt_events_actorId_createdAt_idx"
  ON "stock_receipt_events"("actorId", "createdAt");

CREATE UNIQUE INDEX "inventory_transactions_stockReceiptLineId_key"
  ON "inventory_transactions"("stockReceiptLineId");
CREATE INDEX "inventory_allocations_stockReceiptLineId_idx"
  ON "inventory_allocations"("stockReceiptLineId");
CREATE INDEX "inventory_allocations_sourceReturnHoldId_idx"
  ON "inventory_allocations"("sourceReturnHoldId");

ALTER TABLE "stock_receipts"
  ADD CONSTRAINT "stock_receipts_purchaseCommitmentId_fkey"
    FOREIGN KEY ("purchaseCommitmentId") REFERENCES "purchase_commitments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipts_receivedById_fkey"
    FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipts_business_values_check"
    CHECK ("version" > 0
      AND length(btrim("receiptNumber")) > 0
      AND length(btrim("commandId")) > 0
      AND length(btrim("requestHash")) > 0
      AND length(btrim("supplierDeliveryReference")) > 0);

ALTER TABLE "stock_receipt_lines"
  ADD CONSTRAINT "stock_receipt_lines_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "stock_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_lines_purchaseCommitmentLineId_fkey"
    FOREIGN KEY ("purchaseCommitmentLineId") REFERENCES "purchase_commitment_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_lines_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_lines_inventoryDetailId_fkey"
    FOREIGN KEY ("inventoryDetailId") REFERENCES "inventory_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_lines_business_values_check"
    CHECK ("lineNo" > 0 AND "quantity" > 0 AND "version" > 0
      AND (
        ("status" = 'PENDING_REVIEW'
          AND "inventoryDetailId" IS NULL AND "reviewedById" IS NULL
          AND "reviewedAt" IS NULL AND "reviewReason" IS NULL)
        OR
        ("status" = 'ACCEPTED'
          AND "inventoryDetailId" IS NOT NULL AND "reviewedById" IS NOT NULL
          AND "reviewedAt" IS NOT NULL AND length(btrim(COALESCE("reviewReason", ''))) > 0)
        OR
        ("status" = 'REJECTED'
          AND "inventoryDetailId" IS NULL AND "reviewedById" IS NOT NULL
          AND "reviewedAt" IS NOT NULL AND length(btrim(COALESCE("reviewReason", ''))) > 0)
      ));

ALTER TABLE "stock_receipt_events"
  ADD CONSTRAINT "stock_receipt_events_stockReceiptId_fkey"
    FOREIGN KEY ("stockReceiptId") REFERENCES "stock_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_events_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_events_business_values_check"
    CHECK (length(btrim("kind")) > 0 AND "quantity" >= 0
      AND "eventNo" > 0 AND length(btrim("commandId")) > 0
      AND length(btrim("requestHash")) > 0);

ALTER TABLE "inventory_transactions"
  ADD CONSTRAINT "inventory_transactions_stockReceiptLineId_fkey"
    FOREIGN KEY ("stockReceiptLineId") REFERENCES "stock_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_transactions_stockReceiptLineId_check"
    CHECK ("stockReceiptLineId" IS NULL OR ("type" = 'INBOUND' AND "quantity" > 0));

ALTER TABLE "inventory_allocations"
  ADD CONSTRAINT "inventory_allocations_stockReceiptLineId_fkey"
    FOREIGN KEY ("stockReceiptLineId") REFERENCES "stock_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_allocations_sourceReturnHoldId_fkey"
    FOREIGN KEY ("sourceReturnHoldId") REFERENCES "return_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_allocations_source_exclusive_check"
    CHECK (NOT ("stockReceiptLineId" IS NOT NULL AND "sourceReturnHoldId" IS NOT NULL));

-- Keep receipt and purchase-line counters tied to the explicit immutable
-- receipt facts.  Rejected history is retained but consumes neither arrival
-- capacity nor accepted inventory.
CREATE OR REPLACE FUNCTION assert_stock_receipt_line_integrity(p_line_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_receipt_id TEXT;
  v_commitment_id TEXT;
  v_line_commitment_id TEXT;
  v_purchase_line_id TEXT;
  v_order_line_id TEXT;
  v_quotation_line_id TEXT;
  v_rfq_line_id TEXT;
  v_line_quantity INTEGER;
  v_line_status TEXT;
  v_inventory_detail_id TEXT;
  v_identity_snapshot JSONB;
  v_purchase_quantity INTEGER;
  v_cancelled_quantity INTEGER;
  v_received_quantity INTEGER;
  v_direct_shipped_quantity INTEGER;
  v_pending BIGINT;
  v_accepted BIGINT;
  v_rejected BIGINT;
  v_tx_count BIGINT;
  v_tx_id TEXT;
  v_tx_detail_id TEXT;
  v_tx_type TEXT;
  v_tx_quantity INTEGER;
  v_detail_stock_lot_key TEXT;
  v_detail_item_id TEXT;
  v_detail_serial_number TEXT;
  v_detail_batch_number TEXT;
  v_detail_condition_code TEXT;
  v_detail_quantity INTEGER;
  v_detail_part_number TEXT;
  v_detail_uom TEXT;
  v_detail_tracking_type TEXT;
BEGIN
  SELECT srl."receiptId", sr."purchaseCommitmentId", srl."purchaseCommitmentLineId",
         pcl."purchaseCommitmentId", pcl."orderLineId", ol."quotationLineId",
         ql."rfqLineId", srl."quantity", srl."status"::TEXT,
         srl."inventoryDetailId", srl."identitySnapshot", pcl."quantity",
         pcl."cancelledQuantity", pcl."receivedQuantity", pcl."directShippedQuantity"
    INTO v_receipt_id, v_commitment_id, v_purchase_line_id, v_line_commitment_id,
         v_order_line_id, v_quotation_line_id, v_rfq_line_id, v_line_quantity,
         v_line_status, v_inventory_detail_id, v_identity_snapshot, v_purchase_quantity,
         v_cancelled_quantity, v_received_quantity, v_direct_shipped_quantity
  FROM "stock_receipt_lines" srl
  JOIN "stock_receipts" sr ON sr."id" = srl."receiptId"
  JOIN "purchase_commitment_lines" pcl ON pcl."id" = srl."purchaseCommitmentLineId"
  JOIN "order_lines" ol ON ol."id" = pcl."orderLineId"
  JOIN "quotation_lines" ql ON ql."id" = ol."quotationLineId"
  WHERE srl."id" = p_line_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_commitment_id IS DISTINCT FROM v_line_commitment_id THEN
    RAISE EXCEPTION '收货行必须属于同一采购承诺';
  END IF;
  IF v_line_status = 'PENDING_REVIEW' AND NOT EXISTS (
    SELECT 1 FROM "purchase_commitments" pc
    WHERE pc."id" = v_commitment_id AND pc."status"::TEXT = 'CONFIRMED'
  ) THEN
    RAISE EXCEPTION '待审收货行只能属于已确认采购承诺';
  END IF;
  IF v_line_status = 'ACCEPTED' AND NOT EXISTS (
    SELECT 1 FROM "purchase_commitments" pc
    WHERE pc."id" = v_commitment_id AND pc."status"::TEXT IN ('CONFIRMED', 'CLOSED')
  ) THEN
    RAISE EXCEPTION '已验收收货行只能属于已确认或已关闭采购承诺';
  END IF;
  IF v_line_status = 'REJECTED' AND NOT EXISTS (
    SELECT 1 FROM "purchase_commitments" pc
    WHERE pc."id" = v_commitment_id AND pc."status"::TEXT IN ('CONFIRMED', 'CLOSED', 'CANCELLED')
  ) THEN
    RAISE EXCEPTION '已拒收收货行只能属于已确认、已关闭或已取消采购承诺';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN "status" = 'PENDING_REVIEW' THEN "quantity" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "status" = 'ACCEPTED' THEN "quantity" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "status" = 'REJECTED' THEN "quantity" ELSE 0 END), 0)
    INTO v_pending, v_accepted, v_rejected
  FROM "stock_receipt_lines"
  WHERE "purchaseCommitmentLineId" = v_purchase_line_id;

  IF v_accepted <> v_received_quantity THEN
    RAISE EXCEPTION '收货验收量必须等于采购行 receivedQuantity: %', v_purchase_line_id;
  END IF;
  IF v_pending + v_accepted + v_cancelled_quantity + v_direct_shipped_quantity > v_purchase_quantity THEN
    RAISE EXCEPTION '收货待审、验收、取消及直发数量超过采购承诺: %', v_purchase_line_id;
  END IF;

  IF v_line_status = 'ACCEPTED' THEN
    SELECT d."stockLotKey", d."inventoryItemId", d."serialNumber", d."batchNumber",
           d."conditionCode", d."quantity", ii."partNumber", ii."unitOfMeasure",
           ii."trackingType"
      INTO v_detail_stock_lot_key, v_detail_item_id, v_detail_serial_number,
           v_detail_batch_number, v_detail_condition_code, v_detail_quantity,
           v_detail_part_number, v_detail_uom, v_detail_tracking_type
    FROM "inventory_details" d
    JOIN "inventory_items" ii ON ii."id" = d."inventoryItemId"
    WHERE d."id" = v_inventory_detail_id;
    IF NOT FOUND OR v_detail_stock_lot_key IS DISTINCT FROM p_line_id THEN
      RAISE EXCEPTION '已验收收货行必须绑定以收货行 ID 为 stockLotKey 的实物: %', p_line_id;
    END IF;
    IF jsonb_typeof(v_identity_snapshot) IS DISTINCT FROM 'object'
      OR NOT (v_identity_snapshot ?& ARRAY[
        'schemaVersion', 'purchaseCommitmentLineId', 'orderLineId',
        'quotationLineId', 'rfqLineId', 'partNumber', 'uom', 'serialNumber',
        'batchNumber', 'conditionCode', 'trackingType'
      ])
      OR v_identity_snapshot->>'schemaVersion' IS DISTINCT FROM '1'
      OR v_identity_snapshot->>'purchaseCommitmentLineId' IS DISTINCT FROM v_purchase_line_id
      OR v_identity_snapshot->>'orderLineId' IS DISTINCT FROM v_order_line_id
      OR v_identity_snapshot->>'quotationLineId' IS DISTINCT FROM v_quotation_line_id
      OR v_identity_snapshot->>'rfqLineId' IS DISTINCT FROM v_rfq_line_id
      OR v_identity_snapshot->>'partNumber' IS DISTINCT FROM v_detail_part_number
      OR v_identity_snapshot->>'uom' IS DISTINCT FROM v_detail_uom
      OR v_identity_snapshot->>'serialNumber' IS DISTINCT FROM v_detail_serial_number
      OR v_identity_snapshot->>'batchNumber' IS DISTINCT FROM v_detail_batch_number
      OR v_identity_snapshot->>'conditionCode' IS DISTINCT FROM v_detail_condition_code
      OR v_identity_snapshot->>'trackingType' IS DISTINCT FROM v_detail_tracking_type THEN
      RAISE EXCEPTION '收货行实物身份快照与库存明细或采购来源不一致: %', p_line_id;
    END IF;
    SELECT COUNT(*), MIN("id"), MIN("inventoryDetailId"), MIN("type"), MIN("quantity")
      INTO v_tx_count, v_tx_id, v_tx_detail_id, v_tx_type, v_tx_quantity
    FROM "inventory_transactions"
    WHERE "stockReceiptLineId" = p_line_id;
    IF v_inventory_detail_id IS NULL OR v_tx_count <> 1
      OR v_tx_detail_id IS DISTINCT FROM v_inventory_detail_id
      OR v_tx_type IS DISTINCT FROM 'INBOUND'
      OR v_tx_quantity IS DISTINCT FROM v_line_quantity THEN
      RAISE EXCEPTION '已验收收货行必须有唯一且同数量的 INBOUND 来源流水: %', p_line_id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM "inventory_transactions"
      WHERE "inventoryDetailId" = v_inventory_detail_id
        AND "type" = 'INBOUND' AND "id" <> v_tx_id
    ) THEN
      RAISE EXCEPTION '一个已验收实物不能再有无来源或重复 INBOUND 流水: %', v_inventory_detail_id;
    END IF;
  END IF;
END;
$$;

-- A new arrival may only be opened against a CONFIRMED commitment.  Once the
-- immutable arrival line exists, a pending QC line still needs CONFIRMED,
-- acceptance may finish while the commitment is CLOSED, and a rejected line
-- may remain auditable after the commitment is CANCELLED.
CREATE OR REPLACE FUNCTION guard_stock_receipt_line_commitment_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT pc."status"::TEXT INTO v_status
  FROM "purchase_commitment_lines" pcl
  JOIN "purchase_commitments" pc ON pc."id" = pcl."purchaseCommitmentId"
  WHERE pcl."id" = NEW."purchaseCommitmentLineId";
  IF NOT FOUND THEN
    RAISE EXCEPTION '收货行采购来源不存在: %', NEW."purchaseCommitmentLineId";
  END IF;
  -- Serialize pending/accepted/rejected quantities for this purchase line.
  -- The deferred SUM assertion alone would permit two READ COMMITTED arrival
  -- commands to each observe the same remaining capacity.
  UPDATE "purchase_commitment_lines"
  SET "version" = "version" + 1
  WHERE "id" = NEW."purchaseCommitmentLineId";
  IF NOT FOUND THEN
    RAISE EXCEPTION '收货行采购来源在并发更新中消失: %', NEW."purchaseCommitmentLineId";
  END IF;
  IF TG_OP = 'INSERT' AND v_status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION '新收货事实只能登记在已确认采购承诺上';
  END IF;
  IF NEW."status" = 'PENDING_REVIEW' AND v_status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION '待审收货行只能属于已确认采购承诺';
  END IF;
  IF NEW."status" = 'ACCEPTED' AND v_status NOT IN ('CONFIRMED', 'CLOSED') THEN
    RAISE EXCEPTION '已验收收货行只能属于已确认或已关闭采购承诺';
  END IF;
  IF NEW."status" = 'REJECTED' AND v_status NOT IN ('CONFIRMED', 'CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION '已拒收收货行只能属于已确认、已关闭或已取消采购承诺';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_stock_receipt_line_commitment_status_trigger
  BEFORE INSERT OR UPDATE ON "stock_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION guard_stock_receipt_line_commitment_status();

CREATE OR REPLACE FUNCTION assert_stock_receipt_integrity(p_receipt_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_commitment_id TEXT;
  v_line_id TEXT;
BEGIN
  SELECT "purchaseCommitmentId" INTO v_commitment_id
  FROM "stock_receipts" WHERE "id" = p_receipt_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "stock_receipt_lines" WHERE "receiptId" = p_receipt_id) THEN
    RAISE EXCEPTION '收货单必须至少有一条收货行: %', p_receipt_id;
  END IF;
  FOR v_line_id IN
    SELECT srl."id" FROM "stock_receipt_lines" srl
    WHERE srl."receiptId" = p_receipt_id ORDER BY srl."lineNo"
  LOOP
    PERFORM assert_stock_receipt_line_integrity(v_line_id);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM "stock_receipt_lines" srl
    JOIN "purchase_commitment_lines" pcl ON pcl."id" = srl."purchaseCommitmentLineId"
    WHERE srl."receiptId" = p_receipt_id AND pcl."purchaseCommitmentId" <> v_commitment_id
  ) THEN
    RAISE EXCEPTION '收货单的所有行必须属于该采购承诺: %', p_receipt_id;
  END IF;
END;
$$;

-- A source-bearing allocation consumes one explicit physical pool.  Source
-- capacity is allocatedQuantity-releasedQuantity, so consumed history remains
-- occupied and cannot be silently replenished by a return.
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
  PERFORM 1 FROM "inventory_details" WHERE "id" = v_detail_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION assert_inventory_transaction_source(p_transaction_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_line_id TEXT;
  v_detail_id TEXT;
  v_type TEXT;
  v_quantity INTEGER;
  v_source_detail_id TEXT;
  v_source_status TEXT;
  v_source_quantity INTEGER;
BEGIN
  SELECT "stockReceiptLineId", "inventoryDetailId", "type", "quantity"
    INTO v_line_id, v_detail_id, v_type, v_quantity
  FROM "inventory_transactions" WHERE "id" = p_transaction_id;
  IF NOT FOUND OR v_line_id IS NULL THEN
    RETURN;
  END IF;
  SELECT "inventoryDetailId", "status"::TEXT, "quantity"
    INTO v_source_detail_id, v_source_status, v_source_quantity
  FROM "stock_receipt_lines" WHERE "id" = v_line_id;
  IF NOT FOUND OR v_source_status IS DISTINCT FROM 'ACCEPTED'
    OR v_source_detail_id IS DISTINCT FROM v_detail_id
    OR v_type IS DISTINCT FROM 'INBOUND'
    OR v_quantity IS DISTINCT FROM v_source_quantity THEN
    RAISE EXCEPTION '收货来源流水必须唯一对应同数量的已验收收货行: %', p_transaction_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "inventory_transactions"
    WHERE "inventoryDetailId" = v_detail_id AND "type" = 'INBOUND'
      AND "id" <> p_transaction_id
  ) THEN
    RAISE EXCEPTION '已验收实物不能有第二条 INBOUND 流水: %', v_detail_id;
  END IF;
END;
$$;

-- A non-legacy detail is a receipt-owned physical lot.  Its source key is
-- immutable and must point back to the one accepted receipt line that created
-- it.  This blocks a generic inventory create/update from inventing a source
-- key or moving a receipt lot between receipt lines.
CREATE OR REPLACE FUNCTION assert_inventory_detail_stock_lot(p_detail_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_stock_lot_key TEXT;
  v_receipt_line_detail_id TEXT;
  v_receipt_line_status TEXT;
  v_receipt_line_id TEXT;
BEGIN
  SELECT "stockLotKey" INTO v_stock_lot_key
  FROM "inventory_details" WHERE "id" = p_detail_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_stock_lot_key IS NULL OR length(btrim(v_stock_lot_key)) = 0 THEN
    RAISE EXCEPTION '库存明细 stockLotKey 不能为空: %', p_detail_id;
  END IF;
  IF v_stock_lot_key = 'LEGACY' THEN
    RETURN;
  END IF;

  SELECT srl."id", srl."inventoryDetailId", srl."status"::TEXT
    INTO v_receipt_line_id, v_receipt_line_detail_id, v_receipt_line_status
  FROM "stock_receipt_lines" srl
  WHERE srl."id" = v_stock_lot_key;
  IF NOT FOUND OR v_receipt_line_status IS DISTINCT FROM 'ACCEPTED'
    OR v_receipt_line_detail_id IS DISTINCT FROM p_detail_id THEN
    RAISE EXCEPTION '非 LEGACY 库存明细必须对应同一已验收收货行: %', p_detail_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "stock_receipt_lines"
    WHERE "inventoryDetailId" = p_detail_id AND "status" = 'ACCEPTED'
      AND "id" <> v_receipt_line_id
  ) THEN
    RAISE EXCEPTION '一个库存明细不能对应多个已验收收货行: %', p_detail_id;
  END IF;

  -- The line function also compares the immutable PN/UOM/tracking and
  -- serial/batch/condition identity snapshot.  It is deferred with this
  -- trigger so the acceptance command may create/update the rows in one TX.
  PERFORM assert_stock_receipt_line_integrity(v_receipt_line_id);
END;
$$;

-- Receipt-owned detail quantities are a ledger projection, never a manual
-- adjustment.  The only allowed movement after the single source INBOUND is
-- modern allocation-backed OUTBOUND and a RETURN backed by a released hold.
CREATE OR REPLACE FUNCTION assert_inventory_detail_receipt_ledger(p_detail_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_stock_lot_key TEXT;
  v_receipt_line_quantity INTEGER;
  v_detail_quantity INTEGER;
  v_inbound_count BIGINT;
  v_inbound_quantity BIGINT;
  v_net_quantity BIGINT;
  v_bad_transaction TEXT;
BEGIN
  SELECT "stockLotKey", "quantity" INTO v_stock_lot_key, v_detail_quantity
  FROM "inventory_details" WHERE "id" = p_detail_id;
  IF NOT FOUND OR v_stock_lot_key IS NULL OR v_stock_lot_key = 'LEGACY' THEN
    RETURN;
  END IF;
  SELECT "quantity" INTO v_receipt_line_quantity
  FROM "stock_receipt_lines"
  WHERE "id" = v_stock_lot_key AND "status" = 'ACCEPTED'
    AND "inventoryDetailId" = p_detail_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '采购收货库存缺少已验收来源: %', p_detail_id;
  END IF;

  SELECT COUNT(*), COALESCE(SUM("quantity"::BIGINT), 0)
    INTO v_inbound_count, v_inbound_quantity
  FROM "inventory_transactions"
  WHERE "inventoryDetailId" = p_detail_id AND "type" = 'INBOUND';
  IF v_inbound_count <> 1 OR v_inbound_quantity <> v_receipt_line_quantity
    OR EXISTS (
      SELECT 1 FROM "inventory_transactions"
      WHERE "inventoryDetailId" = p_detail_id AND "type" = 'INBOUND'
        AND ("stockReceiptLineId" IS DISTINCT FROM v_stock_lot_key
          OR "quantity" <> v_receipt_line_quantity
          OR "beforeQuantity" <> 0
          OR "afterQuantity" <> v_receipt_line_quantity)
    ) THEN
    RAISE EXCEPTION '采购收货库存必须只有一条同数量的来源 INBOUND: %', p_detail_id;
  END IF;

  SELECT SUM("quantity"::BIGINT) INTO v_net_quantity
  FROM "inventory_transactions"
  WHERE "inventoryDetailId" = p_detail_id;
  IF COALESCE(v_net_quantity, 0) <> v_detail_quantity THEN
    RAISE EXCEPTION '采购收货库存数量必须等于受控流水净额: %', p_detail_id;
  END IF;

  SELECT "id" INTO v_bad_transaction
  FROM "inventory_transactions" it
  WHERE it."inventoryDetailId" = p_detail_id
    AND (
      it."type" NOT IN ('INBOUND', 'OUTBOUND', 'RETURN')
      OR (it."type" = 'INBOUND' AND (it."quantity" <= 0 OR it."stockReceiptLineId" IS DISTINCT FROM v_stock_lot_key))
      OR (it."type" = 'OUTBOUND' AND (it."quantity" >= 0 OR it."allocationId" IS NULL OR it."assignmentId" IS NULL
        OR it."fulfillmentReviewId" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM "inventory_allocations" ia
          WHERE ia."id" = it."allocationId" AND ia."inventoryDetailId" = p_detail_id
            AND (ia."stockReceiptLineId" = v_stock_lot_key OR ia."sourceReturnHoldId" IS NOT NULL)
        )))
      OR (it."type" = 'RETURN' AND (it."quantity" <= 0 OR it."referenceType" IS DISTINCT FROM 'RETURN'
        OR NOT EXISTS (
          SELECT 1 FROM "return_holds" rh
          WHERE rh."returnTransactionId" = it."id" AND rh."inventoryDetailId" = p_detail_id
            AND rh."status" = 'RELEASED' AND rh."quantity" = it."quantity"
        )))
    )
  ORDER BY it."id"
  LIMIT 1;
  IF v_bad_transaction IS NOT NULL THEN
    RAISE EXCEPTION '采购收货库存只能通过来源 INBOUND、现代 OUTBOUND 或已放行 RETURN 变更: %', v_bad_transaction;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "inventory_transactions"
    WHERE "inventoryDetailId" = p_detail_id
      AND "beforeQuantity" + "quantity" <> "afterQuantity"
  ) THEN
    RAISE EXCEPTION '采购收货库存流水前后数量不连续: %', p_detail_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION protect_inventory_detail_stock_lot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."stockLotKey" IS DISTINCT FROM OLD."stockLotKey" THEN
    RAISE EXCEPTION '库存明细 stockLotKey 创建后不可改写';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_inventory_detail_stock_lot_trigger
  BEFORE UPDATE ON "inventory_details"
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_detail_stock_lot();

CREATE OR REPLACE FUNCTION validate_inventory_detail_stock_lot_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_inventory_detail_stock_lot(NEW."id");
  PERFORM assert_inventory_detail_receipt_ledger(NEW."id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_detail_stock_lot_guard
  AFTER INSERT OR UPDATE ON "inventory_details"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_inventory_detail_stock_lot_trigger();

-- Provenance is assigned at allocation creation and is never retrofitted onto
-- a legacy allocation.  A source change would otherwise move historical stock
-- between the procurement and return pools without a receiving/return fact.
CREATE OR REPLACE FUNCTION protect_inventory_allocation_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND ROW(NEW."stockReceiptLineId", NEW."sourceReturnHoldId") IS DISTINCT FROM
        ROW(OLD."stockReceiptLineId", OLD."sourceReturnHoldId") THEN
    RAISE EXCEPTION '库存分配来源创建后不可改写';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_inventory_allocation_source_trigger
  BEFORE UPDATE ON "inventory_allocations"
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_allocation_source();

CREATE OR REPLACE FUNCTION protect_stock_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '收货事实不可删除';
  END IF;
  IF NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION '收货单 version 必须递增';
  END IF;
  IF ROW(NEW."id", NEW."purchaseCommitmentId", NEW."receiptNumber", NEW."commandId",
      NEW."requestHash", NEW."receivedById", NEW."receivedAt", NEW."supplierDeliveryReference",
      NEW."evidence", NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id", OLD."purchaseCommitmentId", OLD."receiptNumber", OLD."commandId",
      OLD."requestHash", OLD."receivedById", OLD."receivedAt", OLD."supplierDeliveryReference",
      OLD."evidence", OLD."createdAt") THEN
    RAISE EXCEPTION '收货单创建事实不可改写';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_stock_receipt_trigger
  BEFORE UPDATE OR DELETE ON "stock_receipts"
  FOR EACH ROW EXECUTE FUNCTION protect_stock_receipt();

CREATE OR REPLACE FUNCTION protect_stock_receipt_line()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '收货行事实不可删除';
  END IF;
  IF NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION '收货行 version 必须递增';
  END IF;
  IF ROW(NEW."id", NEW."receiptId", NEW."lineNo", NEW."purchaseCommitmentLineId",
      NEW."quantity", NEW."identitySnapshot", NEW."qualitySnapshot", NEW."evidence", NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id", OLD."receiptId", OLD."lineNo", OLD."purchaseCommitmentLineId",
      OLD."quantity", OLD."identitySnapshot", OLD."qualitySnapshot", OLD."evidence", OLD."createdAt") THEN
    RAISE EXCEPTION '收货行身份和到货数量不可改写';
  END IF;
  IF OLD."status" <> 'PENDING_REVIEW' AND ROW(NEW."status", NEW."inventoryDetailId",
      NEW."reviewedById", NEW."reviewedAt", NEW."reviewReason") IS DISTINCT FROM
      ROW(OLD."status", OLD."inventoryDetailId", OLD."reviewedById",
      OLD."reviewedAt", OLD."reviewReason") THEN
    RAISE EXCEPTION '已审核收货行不可重复审核或改写库存绑定';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_stock_receipt_line_trigger
  BEFORE UPDATE OR DELETE ON "stock_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION protect_stock_receipt_line();

CREATE OR REPLACE FUNCTION protect_stock_receipt_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION '收货事件只追加不可改写';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_stock_receipt_event_trigger
  BEFORE UPDATE OR DELETE ON "stock_receipt_events"
  FOR EACH ROW EXECUTE FUNCTION protect_stock_receipt_event();

-- The shared D12/D14 coverage guard must not count an allocation whose parent
-- is explicitly sourced from a purchase receipt.  Return-pool allocations
-- intentionally remain OWN coverage because their receipt is not a new
-- procurement commitment.
CREATE OR REPLACE FUNCTION assert_order_line_coverage(order_line_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  order_quantity BIGINT;
  owned_coverage BIGINT;
  purchase_coverage BIGINT;
  total_coverage BIGINT;
BEGIN
  SELECT "quantity"::BIGINT INTO order_quantity
  FROM "order_lines" WHERE "id" = order_line_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(aa."assignedQuantity"::BIGINT - aa."releasedQuantity"::BIGINT), 0)
    INTO owned_coverage
  FROM "allocation_assignments" aa
  JOIN "inventory_allocations" ia ON ia."id" = aa."allocationId"
  WHERE aa."orderLineId" = order_line_id
    AND ia."stockReceiptLineId" IS NULL;

  SELECT COALESCE(SUM(pcl."quantity"::BIGINT - pcl."cancelledQuantity"::BIGINT), 0)
    INTO purchase_coverage
  FROM "purchase_commitment_lines" pcl
  JOIN "purchase_commitments" pc ON pc."id" = pcl."purchaseCommitmentId"
  WHERE pcl."orderLineId" = order_line_id
    AND pc."status"::TEXT IN ('PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED');

  IF owned_coverage < 0 OR purchase_coverage < 0 THEN
    RAISE EXCEPTION '订单行覆盖事实出现负数: %', order_line_id USING ERRCODE = '23514';
  END IF;
  total_coverage := owned_coverage + purchase_coverage;
  IF total_coverage > order_quantity THEN
    RAISE EXCEPTION '订单行采购与库存覆盖超过需求: orderLineId=%, covered=%, quantity=%',
      order_line_id, total_coverage, order_quantity USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_order_line_coverage_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_order_line_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'purchase_commitments' THEN
    IF TG_OP = 'DELETE' THEN
      FOR affected_order_line_id IN
        SELECT "orderLineId" FROM "purchase_commitment_lines"
        WHERE "purchaseCommitmentId" = OLD."id" ORDER BY "orderLineId"
      LOOP PERFORM assert_order_line_coverage(affected_order_line_id); END LOOP;
    ELSE
      FOR affected_order_line_id IN
        SELECT "orderLineId" FROM "purchase_commitment_lines"
        WHERE "purchaseCommitmentId" = NEW."id" ORDER BY "orderLineId"
      LOOP PERFORM assert_order_line_coverage(affected_order_line_id); END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'purchase_commitment_lines' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM assert_order_line_coverage(OLD."orderLineId"); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_order_line_coverage(NEW."orderLineId"); END IF;
  ELSIF TG_TABLE_NAME = 'allocation_assignments' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM assert_order_line_coverage(OLD."orderLineId"); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_order_line_coverage(NEW."orderLineId"); END IF;
  ELSIF TG_TABLE_NAME = 'inventory_allocations' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      FOR affected_order_line_id IN
        SELECT "orderLineId" FROM "allocation_assignments"
        WHERE "allocationId" = OLD."id" ORDER BY "orderLineId"
      LOOP PERFORM assert_order_line_coverage(affected_order_line_id); END LOOP;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      FOR affected_order_line_id IN
        SELECT "orderLineId" FROM "allocation_assignments"
        WHERE "allocationId" = NEW."id" ORDER BY "orderLineId"
      LOOP PERFORM assert_order_line_coverage(affected_order_line_id); END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'order_lines' THEN
    PERFORM assert_order_line_coverage(NEW."id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION lock_inventory_allocation_order_line_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_order_line_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOR affected_order_line_id IN
      SELECT "orderLineId" FROM "allocation_assignments"
      WHERE "allocationId" = OLD."id" ORDER BY "orderLineId"
    LOOP PERFORM lock_order_line_coverage_row(affected_order_line_id); END LOOP;
  ELSE
    FOR affected_order_line_id IN
      SELECT "orderLineId" FROM "allocation_assignments"
      WHERE "allocationId" = NEW."id" ORDER BY "orderLineId"
    LOOP PERFORM lock_order_line_coverage_row(affected_order_line_id); END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_allocation_coverage_lock
  BEFORE INSERT OR UPDATE OR DELETE ON "inventory_allocations"
  FOR EACH ROW EXECUTE FUNCTION lock_inventory_allocation_order_line_coverage();

CREATE CONSTRAINT TRIGGER inventory_allocation_coverage_guard
  AFTER INSERT OR UPDATE OR DELETE ON "inventory_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_order_line_coverage_trigger();

-- Source and receipt assertions are deferred so a single acceptance command
-- may create the detail, bind the receipt line, write INBOUND, and increment
-- PurchaseCommitmentLine.receivedQuantity in any safe order.
CREATE OR REPLACE FUNCTION validate_stock_receipt_line_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allocation_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '收货行事实不可删除';
  END IF;
  PERFORM assert_stock_receipt_line_integrity(NEW."id");
  IF NEW."inventoryDetailId" IS NOT NULL THEN
    PERFORM assert_inventory_detail_stock_lot(NEW."inventoryDetailId");
    PERFORM assert_inventory_detail_receipt_ledger(NEW."inventoryDetailId");
  END IF;
  FOR v_allocation_id IN
    SELECT "id" FROM "inventory_allocations"
    WHERE "stockReceiptLineId" = NEW."id" ORDER BY "id"
  LOOP PERFORM assert_inventory_allocation_source(v_allocation_id); END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER stock_receipt_line_integrity_guard
  AFTER INSERT OR UPDATE OR DELETE ON "stock_receipt_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_stock_receipt_line_trigger();

CREATE OR REPLACE FUNCTION validate_stock_receipt_header_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '收货单事实不可删除';
  END IF;
  PERFORM assert_stock_receipt_integrity(NEW."id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER stock_receipt_header_integrity_guard
  AFTER INSERT OR UPDATE ON "stock_receipts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_stock_receipt_header_trigger();

CREATE OR REPLACE FUNCTION validate_purchase_line_receipt_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_line_id TEXT;
  v_purchase_line_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_purchase_line_id := OLD."id";
  ELSE
    v_purchase_line_id := NEW."id";
  END IF;
  FOR v_line_id IN
    SELECT "id" FROM "stock_receipt_lines"
    WHERE "purchaseCommitmentLineId" = v_purchase_line_id ORDER BY "id"
  LOOP PERFORM assert_stock_receipt_line_integrity(v_line_id); END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER purchase_line_receipt_integrity_guard
  AFTER INSERT OR UPDATE OR DELETE ON "purchase_commitment_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_purchase_line_receipt_trigger();

CREATE OR REPLACE FUNCTION validate_inventory_transaction_receipt_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."stockReceiptLineId" IS NOT NULL THEN
      PERFORM assert_stock_receipt_line_integrity(OLD."stockReceiptLineId");
    END IF;
    PERFORM assert_inventory_detail_stock_lot(OLD."inventoryDetailId");
    PERFORM assert_inventory_detail_receipt_ledger(OLD."inventoryDetailId");
  ELSE
    IF NEW."stockReceiptLineId" IS NOT NULL THEN
      PERFORM assert_inventory_transaction_source(NEW."id");
      PERFORM assert_stock_receipt_line_integrity(NEW."stockReceiptLineId");
    END IF;
    PERFORM assert_inventory_detail_stock_lot(NEW."inventoryDetailId");
    PERFORM assert_inventory_detail_receipt_ledger(NEW."inventoryDetailId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_transaction_receipt_integrity_guard
  AFTER INSERT OR UPDATE OR DELETE ON "inventory_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_inventory_transaction_receipt_trigger();

CREATE OR REPLACE FUNCTION validate_inventory_allocation_source_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allocation_id TEXT;
  v_source_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'inventory_allocations' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_inventory_allocation_source(NEW."id"); END IF;
  ELSIF TG_TABLE_NAME = 'allocation_assignments' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM assert_inventory_allocation_source(OLD."allocationId"); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM assert_inventory_allocation_source(NEW."allocationId"); END IF;
  ELSIF TG_TABLE_NAME = 'stock_receipt_lines' THEN
    IF TG_OP = 'DELETE' THEN
      v_source_id := OLD."id";
    ELSE
      v_source_id := NEW."id";
    END IF;
    FOR v_allocation_id IN
      SELECT "id" FROM "inventory_allocations"
      WHERE "stockReceiptLineId" = v_source_id ORDER BY "id"
    LOOP PERFORM assert_inventory_allocation_source(v_allocation_id); END LOOP;
  ELSIF TG_TABLE_NAME = 'return_holds' THEN
    IF TG_OP = 'DELETE' THEN
      v_source_id := OLD."id";
    ELSE
      v_source_id := NEW."id";
    END IF;
    FOR v_allocation_id IN
      SELECT "id" FROM "inventory_allocations"
      WHERE "sourceReturnHoldId" = v_source_id ORDER BY "id"
    LOOP PERFORM assert_inventory_allocation_source(v_allocation_id); END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER allocation_assignment_source_integrity_guard
  AFTER INSERT OR UPDATE OR DELETE ON "allocation_assignments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_inventory_allocation_source_trigger();

CREATE CONSTRAINT TRIGGER allocation_source_integrity_guard
  AFTER INSERT OR UPDATE ON "inventory_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_inventory_allocation_source_trigger();

CREATE CONSTRAINT TRIGGER receipt_line_source_integrity_guard
  AFTER INSERT OR UPDATE ON "stock_receipt_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_inventory_allocation_source_trigger();

CREATE CONSTRAINT TRIGGER return_hold_source_integrity_guard
  AFTER UPDATE ON "return_holds"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_inventory_allocation_source_trigger();

CREATE OR REPLACE FUNCTION validate_inventory_transaction_source_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."stockReceiptLineId" IS DISTINCT FROM OLD."stockReceiptLineId" THEN
    RAISE EXCEPTION '收货来源流水绑定创建后不可改写';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_inventory_transaction_receipt_source_trigger
  BEFORE UPDATE ON "inventory_transactions"
  FOR EACH ROW EXECUTE FUNCTION validate_inventory_transaction_source_mutation();

-- Migration preflight: this migration creates the first receipt facts and has
-- no safe way to infer a source for an already received purchase line.  A
-- non-zero historical receivedQuantity therefore fails closed instead of
-- silently accepting an unreconciled counter.  Existing details are assigned
-- the explicit LEGACY key by the column default and are not otherwise edited.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "purchase_commitment_lines"
    WHERE "receivedQuantity" <> 0
  ) THEN
    RAISE EXCEPTION '迁移前采购行已有 receivedQuantity 历史事实但没有可验证收货行，必须先只读预检/人工处理';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "inventory_details"
    WHERE "stockLotKey" IS DISTINCT FROM 'LEGACY'
  ) THEN
    RAISE EXCEPTION '迁移前库存明细存在未知 stockLotKey，拒绝猜测来源';
  END IF;
END;
$$;

-- Do not infer any source for existing allocations or inventory transactions.
-- New source-bearing rows are checked by the deferred guards above; callers
-- must make the source and all quantity/provenance facts in one Serializable
-- command before forcing deferred constraints immediate.
