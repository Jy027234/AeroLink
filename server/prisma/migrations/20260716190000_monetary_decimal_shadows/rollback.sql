-- Manual rollback for P1-04's non-destructive shadow migration.
--
-- Run only after rolling application code back to a version that does not
-- dual-write or read these Decimal shadows. The legacy Float columns and all
-- transaction records are intentionally untouched.

ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "exchangeCoreChargeDecimal",
  DROP COLUMN IF EXISTS "totalLandCostDecimal",
  DROP COLUMN IF EXISTS "vatAmountDecimal",
  DROP COLUMN IF EXISTS "importDutyDecimal",
  DROP COLUMN IF EXISTS "totalAmountDecimal";

ALTER TABLE "quotations"
  DROP COLUMN IF EXISTS "costPriceDecimal",
  DROP COLUMN IF EXISTS "totalPriceDecimal",
  DROP COLUMN IF EXISTS "unitPriceDecimal";

ALTER TABLE "supplier_quotes"
  DROP COLUMN IF EXISTS "totalPriceDecimal",
  DROP COLUMN IF EXISTS "unitPriceDecimal";
