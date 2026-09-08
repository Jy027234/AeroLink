-- D14 order-line coverage guard.
--
-- A modern order line may be covered by both owned-stock assignments and
-- active procurement commitments.  The two ledgers use different tables, so
-- row-level checks on either table alone cannot prevent cross-domain write
-- skew.  This migration gives each order line a small lock/version row and
-- checks the combined, historical coverage at deferred-constraint time.
--
-- There is deliberately no purchase provenance on D12 allocations yet.  All
-- AllocationAssignment rows are therefore treated as non-purchase coverage.
-- A receipt adapter must not attach purchased stock to D12 until it has an
-- immutable purchase/receipt FK; the aggregate below must then classify that
-- assignment out of the owned-stock sum before the adapter is enabled.

CREATE TABLE "order_line_coverage_guards" (
  "orderLineId" TEXT NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "order_line_coverage_guards_pkey" PRIMARY KEY ("orderLineId"),
  CONSTRAINT "order_line_coverage_guards_version_check" CHECK ("version" > 0),
  CONSTRAINT "order_line_coverage_guards_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "order_line_coverage_guards" ("orderLineId", "version")
SELECT "id", 1 FROM "order_lines"
ON CONFLICT ("orderLineId") DO NOTHING;

-- New order lines need a guard row before a later assignment or purchase line
-- can acquire the shared lock.  Existing rows were backfilled above.
CREATE OR REPLACE FUNCTION ensure_order_line_coverage_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "order_line_coverage_guards" ("orderLineId", "version")
  VALUES (NEW."id", 1)
  ON CONFLICT ("orderLineId") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_line_coverage_guard_row_init
AFTER INSERT ON "order_lines"
FOR EACH ROW EXECUTE FUNCTION ensure_order_line_coverage_guard();

-- Incrementing the private guard version is intentional.  A FOR UPDATE alone
-- can let an older Serializable snapshot continue after waiting for a lock;
-- this write creates a real rw-conflict.  The business OrderLine row and its
-- updatedAt value remain untouched.
CREATE OR REPLACE FUNCTION lock_order_line_coverage_row(order_line_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  guard_version BIGINT;
BEGIN
  IF order_line_id IS NULL OR btrim(order_line_id) = '' THEN
    RETURN;
  END IF;

  -- Lock the shared business row first.  The private guard row below is the
  -- actual write conflict/version boundary, while this lock keeps direct SQL
  -- and the service's OrderLine pre-lock on one deterministic lock path.
  PERFORM 1 FROM "order_lines"
  WHERE "id" = order_line_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '订单行不存在: %', order_line_id
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO "order_line_coverage_guards" ("orderLineId", "version")
  VALUES (order_line_id, 1)
  ON CONFLICT ("orderLineId") DO NOTHING;

  UPDATE "order_line_coverage_guards"
  SET "version" = "version" + 1
  WHERE "orderLineId" = order_line_id
  RETURNING "version" INTO guard_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION '订单行覆盖锁不存在: %', order_line_id
      USING ERRCODE = '23503';
  END IF;
  IF guard_version <= 0 THEN
    RAISE EXCEPTION '订单行覆盖锁版本无效: %', order_line_id
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION lock_assignment_order_line_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lock_order_line_coverage_row(NEW."orderLineId");
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM lock_order_line_coverage_row(OLD."orderLineId");
    RETURN OLD;
  END IF;
  PERFORM lock_order_line_coverage_row(OLD."orderLineId");
  IF NEW."orderLineId" IS DISTINCT FROM OLD."orderLineId" THEN
    PERFORM lock_order_line_coverage_row(NEW."orderLineId");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER allocation_assignment_coverage_lock
BEFORE INSERT OR UPDATE OR DELETE ON "allocation_assignments"
FOR EACH ROW EXECUTE FUNCTION lock_assignment_order_line_coverage();

CREATE OR REPLACE FUNCTION purchase_line_coverage_status(purchase_commitment_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  purchase_status TEXT;
BEGIN
  SELECT "status"::TEXT INTO purchase_status
  FROM "purchase_commitments"
  WHERE "id" = purchase_commitment_id;
  RETURN purchase_status IN ('PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED');
END;
$$;

CREATE OR REPLACE FUNCTION lock_purchase_line_order_line_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_active BOOLEAN := FALSE;
  new_active BOOLEAN := FALSE;
  parent_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    old_active := purchase_line_coverage_status(OLD."purchaseCommitmentId");
    IF old_active THEN
      PERFORM lock_order_line_coverage_row(OLD."orderLineId");
    END IF;
    RETURN OLD;
  END IF;

  parent_id := NEW."purchaseCommitmentId";
  new_active := purchase_line_coverage_status(parent_id);
  IF new_active THEN
    PERFORM lock_order_line_coverage_row(NEW."orderLineId");
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_active := purchase_line_coverage_status(OLD."purchaseCommitmentId");
    IF old_active THEN
      PERFORM lock_order_line_coverage_row(OLD."orderLineId");
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_commitment_line_coverage_lock
BEFORE INSERT OR UPDATE OR DELETE ON "purchase_commitment_lines"
FOR EACH ROW EXECUTE FUNCTION lock_purchase_line_order_line_coverage();

CREATE OR REPLACE FUNCTION lock_purchase_header_order_line_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_order_line_id TEXT;
  old_active BOOLEAN := FALSE;
  new_active BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    old_active := OLD."status"::TEXT IN ('PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED');
    IF old_active THEN
      FOR line_order_line_id IN
        SELECT "orderLineId" FROM "purchase_commitment_lines"
        WHERE "purchaseCommitmentId" = OLD."id"
        ORDER BY "orderLineId"
      LOOP
        PERFORM lock_order_line_coverage_row(line_order_line_id);
      END LOOP;
    END IF;
    RETURN OLD;
  END IF;

  new_active := NEW."status"::TEXT IN ('PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED');
  old_active := TG_OP = 'UPDATE'
    AND OLD."status"::TEXT IN ('PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED');

  IF new_active OR old_active THEN
    -- The service locks all target lines in this same order.  Sorting here
    -- keeps direct SQL multi-line updates deterministic as well.
    FOR line_order_line_id IN
      SELECT "orderLineId" FROM "purchase_commitment_lines"
      WHERE "purchaseCommitmentId" = NEW."id"
      ORDER BY "orderLineId"
    LOOP
      PERFORM lock_order_line_coverage_row(line_order_line_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_commitment_coverage_lock
BEFORE INSERT OR UPDATE OR DELETE ON "purchase_commitments"
FOR EACH ROW EXECUTE FUNCTION lock_purchase_header_order_line_coverage();

CREATE OR REPLACE FUNCTION lock_changed_order_line_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_order_line_coverage_row(NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_line_coverage_change_lock
BEFORE UPDATE OF "quantity" ON "order_lines"
FOR EACH ROW EXECUTE FUNCTION lock_changed_order_line_coverage();

CREATE OR REPLACE FUNCTION assert_order_line_coverage(order_line_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  order_quantity BIGINT;
  owned_coverage BIGINT;
  purchase_coverage BIGINT;
  total_coverage BIGINT;
BEGIN
  SELECT "quantity"::BIGINT INTO order_quantity
  FROM "order_lines"
  WHERE "id" = order_line_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(
      "assignedQuantity"::BIGINT - "releasedQuantity"::BIGINT
    ), 0)
  INTO owned_coverage
  FROM "allocation_assignments"
  WHERE "orderLineId" = order_line_id;

  SELECT COALESCE(SUM(
      pcl."quantity"::BIGINT - pcl."cancelledQuantity"::BIGINT
    ), 0)
  INTO purchase_coverage
  FROM "purchase_commitment_lines" pcl
  JOIN "purchase_commitments" pc
    ON pc."id" = pcl."purchaseCommitmentId"
  WHERE pcl."orderLineId" = order_line_id
    AND pc."status"::TEXT IN ('PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED');

  IF owned_coverage < 0 OR purchase_coverage < 0 THEN
    RAISE EXCEPTION '订单行覆盖事实出现负数: %', order_line_id
      USING ERRCODE = '23514';
  END IF;

  total_coverage := owned_coverage + purchase_coverage;
  IF total_coverage > order_quantity THEN
    RAISE EXCEPTION '订单行采购与库存覆盖超过需求: orderLineId=%, covered=%, quantity=%',
      order_line_id, total_coverage, order_quantity
      USING ERRCODE = '23514';
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
        WHERE "purchaseCommitmentId" = OLD."id"
      LOOP
        PERFORM assert_order_line_coverage(affected_order_line_id);
      END LOOP;
    ELSE
      FOR affected_order_line_id IN
        SELECT "orderLineId" FROM "purchase_commitment_lines"
        WHERE "purchaseCommitmentId" = NEW."id"
      LOOP
        PERFORM assert_order_line_coverage(affected_order_line_id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'purchase_commitment_lines' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM assert_order_line_coverage(OLD."orderLineId");
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM assert_order_line_coverage(NEW."orderLineId");
    END IF;
  ELSIF TG_TABLE_NAME = 'allocation_assignments' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM assert_order_line_coverage(OLD."orderLineId");
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM assert_order_line_coverage(NEW."orderLineId");
    END IF;
  ELSIF TG_TABLE_NAME = 'order_lines' THEN
    PERFORM assert_order_line_coverage(NEW."id");
  END IF;
  RETURN NULL;
END;
$$;

-- These checks are deferred so a command may write a status, line counters,
-- and assignments in any internally valid sequence.  The application calls
-- SET CONSTRAINTS ALL IMMEDIATE before returning from Serializable work.
CREATE CONSTRAINT TRIGGER purchase_commitment_coverage_guard
AFTER INSERT OR UPDATE OR DELETE ON "purchase_commitments"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_order_line_coverage_trigger();

CREATE CONSTRAINT TRIGGER purchase_commitment_line_coverage_guard
AFTER INSERT OR UPDATE OR DELETE ON "purchase_commitment_lines"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_order_line_coverage_trigger();

CREATE CONSTRAINT TRIGGER allocation_assignment_coverage_guard
AFTER INSERT OR UPDATE OR DELETE ON "allocation_assignments"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_order_line_coverage_trigger();

CREATE CONSTRAINT TRIGGER order_line_quantity_coverage_guard
AFTER UPDATE OF "quantity" ON "order_lines"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_order_line_coverage_trigger();

-- Do not silently repair historical over-coverage while installing the guard.
-- A production database with an existing violation must stop the migration so
-- the owning workflow can reconcile the facts explicitly.
DO $$
DECLARE
  existing_order_line_id TEXT;
BEGIN
  FOR existing_order_line_id IN
    SELECT "id" FROM "order_lines" ORDER BY "id"
  LOOP
    PERFORM assert_order_line_coverage(existing_order_line_id);
  END LOOP;
END;
$$;
