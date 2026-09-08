-- AlterTable
ALTER TABLE "inventory_details" ADD COLUMN     "allocatedQuantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "fulfillment_reviews" ADD COLUMN     "assignmentId" TEXT;

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "allocationId" TEXT,
ADD COLUMN     "assignmentId" TEXT;

-- CreateTable
CREATE TABLE "inventory_allocations" (
    "id" TEXT NOT NULL,
    "quotationLineId" TEXT NOT NULL,
    "inventoryDetailId" TEXT NOT NULL,
    "allocatedQuantity" INTEGER NOT NULL,
    "releasedQuantity" INTEGER NOT NULL DEFAULT 0,
    "consumedQuantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "commandId" TEXT NOT NULL,
    "commandLineNo" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_assignments" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "assignedQuantity" INTEGER NOT NULL,
    "releasedQuantity" INTEGER NOT NULL DEFAULT 0,
    "consumedQuantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "commandId" TEXT NOT NULL,
    "commandLineNo" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allocation_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_allocation_events" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "commandId" TEXT NOT NULL,
    "eventNo" INTEGER NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_allocation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_allocations_quotationLineId_idx" ON "inventory_allocations"("quotationLineId");

-- CreateIndex
CREATE INDEX "inventory_allocations_inventoryDetailId_idx" ON "inventory_allocations"("inventoryDetailId");

-- CreateIndex
CREATE INDEX "inventory_allocations_expiresAt_idx" ON "inventory_allocations"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_allocations_commandId_commandLineNo_key" ON "inventory_allocations"("commandId", "commandLineNo");

-- CreateIndex
CREATE INDEX "allocation_assignments_allocationId_idx" ON "allocation_assignments"("allocationId");

-- CreateIndex
CREATE INDEX "allocation_assignments_orderLineId_idx" ON "allocation_assignments"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "allocation_assignments_commandId_commandLineNo_key" ON "allocation_assignments"("commandId", "commandLineNo");

-- CreateIndex
CREATE INDEX "inventory_allocation_events_allocationId_createdAt_idx" ON "inventory_allocation_events"("allocationId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_allocation_events_assignmentId_createdAt_idx" ON "inventory_allocation_events"("assignmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_allocation_events_commandId_eventNo_key" ON "inventory_allocation_events"("commandId", "eventNo");

-- CreateIndex
CREATE INDEX "fulfillment_reviews_assignmentId_reviewedAt_idx" ON "fulfillment_reviews"("assignmentId", "reviewedAt");

-- CreateIndex
CREATE INDEX "inventory_transactions_allocationId_idx" ON "inventory_transactions"("allocationId");

-- CreateIndex
CREATE INDEX "inventory_transactions_assignmentId_idx" ON "inventory_transactions"("assignmentId");

-- AddForeignKey
ALTER TABLE "fulfillment_reviews" ADD CONSTRAINT "fulfillment_reviews_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "allocation_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_quotationLineId_fkey" FOREIGN KEY ("quotationLineId") REFERENCES "quotation_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_inventoryDetailId_fkey" FOREIGN KEY ("inventoryDetailId") REFERENCES "inventory_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_assignments" ADD CONSTRAINT "allocation_assignments_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "inventory_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_assignments" ADD CONSTRAINT "allocation_assignments_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_assignments" ADD CONSTRAINT "allocation_assignments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_allocation_events" ADD CONSTRAINT "inventory_allocation_events_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "inventory_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_allocation_events" ADD CONSTRAINT "inventory_allocation_events_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "allocation_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_allocation_events" ADD CONSTRAINT "inventory_allocation_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "inventory_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "allocation_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No history is fabricated: legacy reservations keep their old, isolated path.
ALTER TABLE "inventory_details" ADD CONSTRAINT "inventory_allocated_quantity_range"
  CHECK ("allocatedQuantity" >= 0 AND "allocatedQuantity" <= "quantity");
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "allocation_quantity_range"
  CHECK ("allocatedQuantity" > 0 AND "releasedQuantity" >= 0 AND "consumedQuantity" >= 0
    AND "releasedQuantity"::BIGINT + "consumedQuantity" <= "allocatedQuantity"
    AND "version" > 0 AND "commandLineNo" > 0);
ALTER TABLE "allocation_assignments" ADD CONSTRAINT "assignment_quantity_range"
  CHECK ("assignedQuantity" > 0 AND "releasedQuantity" >= 0 AND "consumedQuantity" >= 0
    AND "releasedQuantity"::BIGINT + "consumedQuantity" <= "assignedQuantity"
    AND "version" > 0 AND "commandLineNo" > 0);
ALTER TABLE "inventory_allocation_events" ADD CONSTRAINT "allocation_event_quantity_range"
  CHECK ("quantity" > 0 AND "eventNo" > 0 AND length("kind") > 0);

CREATE FUNCTION protect_allocation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_TABLE_NAME = 'inventory_allocation_events' THEN
    RAISE EXCEPTION 'Allocation history cannot be deleted or replaced';
  END IF;
  IF NEW."releasedQuantity" < OLD."releasedQuantity" OR NEW."consumedQuantity" < OLD."consumedQuantity"
    OR NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION 'Allocation counters must be monotonic and versioned';
  END IF;
  IF TG_TABLE_NAME = 'inventory_allocations' THEN
    IF ROW(NEW."id", NEW."quotationLineId", NEW."inventoryDetailId", NEW."allocatedQuantity", NEW."expiresAt",
      NEW."commandId", NEW."commandLineNo", NEW."createdById", NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id", OLD."quotationLineId", OLD."inventoryDetailId", OLD."allocatedQuantity", OLD."expiresAt",
      OLD."commandId", OLD."commandLineNo", OLD."createdById", OLD."createdAt") THEN
      RAISE EXCEPTION 'Allocation source facts cannot be replaced';
    END IF;
  ELSE
    IF ROW(NEW."id", NEW."allocationId", NEW."orderLineId", NEW."assignedQuantity", NEW."commandId",
      NEW."commandLineNo", NEW."createdById", NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id", OLD."allocationId", OLD."orderLineId", OLD."assignedQuantity", OLD."commandId",
      OLD."commandLineNo", OLD."createdById", OLD."createdAt") THEN
      RAISE EXCEPTION 'Assignment source facts cannot be replaced';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER allocation_history_guard BEFORE UPDATE OR DELETE ON "inventory_allocations"
  FOR EACH ROW EXECUTE FUNCTION protect_allocation_history();
CREATE TRIGGER assignment_history_guard BEFORE UPDATE OR DELETE ON "allocation_assignments"
  FOR EACH ROW EXECUTE FUNCTION protect_allocation_history();
CREATE TRIGGER allocation_event_history_guard BEFORE UPDATE OR DELETE ON "inventory_allocation_events"
  FOR EACH ROW EXECUTE FUNCTION protect_allocation_history();

-- Parent, assignments and physical projection are checked at commit, after
-- every member of a reserve/assign/release/consume transaction has been written.
CREATE FUNCTION assert_allocation_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocation_id TEXT;
  detail_id TEXT;
  parent_row "inventory_allocations"%ROWTYPE;
  assigned BIGINT;
  released BIGINT;
  consumed BIGINT;
  active BIGINT;
  projected INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'inventory_details' THEN
    detail_id := NEW."id";
  ELSE
    IF TG_TABLE_NAME = 'inventory_allocations' THEN
      allocation_id := NEW."id";
    ELSE
      allocation_id := NEW."allocationId";
    END IF;
    SELECT * INTO parent_row FROM "inventory_allocations" WHERE "id" = allocation_id;
    detail_id := parent_row."inventoryDetailId";
    SELECT COALESCE(SUM("assignedQuantity"), 0), COALESCE(SUM("releasedQuantity"), 0), COALESCE(SUM("consumedQuantity"), 0)
      INTO assigned, released, consumed FROM "allocation_assignments" WHERE "allocationId" = allocation_id;
    IF assigned > parent_row."allocatedQuantity" OR consumed <> parent_row."consumedQuantity"
      OR released > parent_row."releasedQuantity"
      OR parent_row."allocatedQuantity" - assigned - parent_row."releasedQuantity" + released < 0 THEN
      RAISE EXCEPTION 'Allocation parent and assignments do not conserve quantity';
    END IF;
    IF EXISTS (SELECT 1 FROM "allocation_assignments" a JOIN "order_lines" l ON l."id" = a."orderLineId"
      WHERE a."allocationId" = allocation_id AND l."quotationLineId" <> parent_row."quotationLineId") THEN
      RAISE EXCEPTION 'Assignment belongs to another quotation line';
    END IF;
  END IF;
  SELECT COALESCE(SUM("allocatedQuantity"::BIGINT - "releasedQuantity" - "consumedQuantity"), 0)
    INTO active FROM "inventory_allocations" WHERE "inventoryDetailId" = detail_id;
  SELECT "allocatedQuantity" INTO projected FROM "inventory_details" WHERE "id" = detail_id;
  IF active <> projected THEN
    RAISE EXCEPTION 'Inventory allocation projection does not match allocation facts';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER allocation_conservation AFTER INSERT OR UPDATE ON "inventory_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_allocation_conservation();
CREATE CONSTRAINT TRIGGER assignment_conservation AFTER INSERT OR UPDATE ON "allocation_assignments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_allocation_conservation();
CREATE CONSTRAINT TRIGGER inventory_allocation_conservation AFTER INSERT OR UPDATE ON "inventory_details"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_allocation_conservation();
