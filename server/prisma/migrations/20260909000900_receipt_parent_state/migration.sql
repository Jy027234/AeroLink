-- A parent-only status change must revalidate immutable receipt children.
-- Updating the same purchase-line rows as an arrival makes concurrent changes
-- serialize under READ COMMITTED and conflict under an older SERIALIZABLE snapshot.
CREATE FUNCTION validate_purchase_receipt_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_line_id TEXT;
  purchase_line_id TEXT;
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN RETURN NULL; END IF;
  FOR purchase_line_id IN SELECT "id" FROM "purchase_commitment_lines"
    WHERE "purchaseCommitmentId" = NEW."id" ORDER BY "id"
  LOOP
    UPDATE "purchase_commitment_lines" SET "version" = "version" + 1 WHERE "id" = purchase_line_id;
  END LOOP;
  FOR receipt_line_id IN
    SELECT srl."id" FROM "stock_receipt_lines" srl
    JOIN "purchase_commitment_lines" pcl ON pcl."id" = srl."purchaseCommitmentLineId"
    WHERE pcl."purchaseCommitmentId" = NEW."id" ORDER BY srl."id"
  LOOP
    PERFORM assert_stock_receipt_line_integrity(receipt_line_id);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER purchase_receipt_state_guard AFTER UPDATE ON "purchase_commitments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_receipt_state();

-- Fail a migration over inconsistent history; never manufacture QC decisions.
DO $$
DECLARE receipt_line_id TEXT;
BEGIN
  FOR receipt_line_id IN SELECT "id" FROM "stock_receipt_lines" ORDER BY "id"
  LOOP PERFORM assert_stock_receipt_line_integrity(receipt_line_id); END LOOP;
END;
$$;
