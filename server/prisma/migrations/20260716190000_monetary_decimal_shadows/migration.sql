-- P1-04 first slice: introduce non-destructive Decimal(18,4) monetary
-- shadows for the core quote-to-order transaction path. Existing Float
-- columns stay in place until all consumers have completed their read cutover.

ALTER TABLE "supplier_quotes"
  ADD COLUMN "unitPriceDecimal" DECIMAL(18, 4),
  ADD COLUMN "totalPriceDecimal" DECIMAL(18, 4);

ALTER TABLE "quotations"
  ADD COLUMN "unitPriceDecimal" DECIMAL(18, 4),
  ADD COLUMN "totalPriceDecimal" DECIMAL(18, 4),
  ADD COLUMN "costPriceDecimal" DECIMAL(18, 4);

ALTER TABLE "orders"
  ADD COLUMN "totalAmountDecimal" DECIMAL(18, 4),
  ADD COLUMN "importDutyDecimal" DECIMAL(18, 4),
  ADD COLUMN "vatAmountDecimal" DECIMAL(18, 4),
  ADD COLUMN "totalLandCostDecimal" DECIMAL(18, 4),
  ADD COLUMN "exchangeCoreChargeDecimal" DECIMAL(18, 4);

-- Backfill with the same four-decimal, half-up policy used by application
-- writes. This is intentionally non-destructive: the Float source remains
-- available for rollback and reconciliation.
UPDATE "supplier_quotes"
SET
  "unitPriceDecimal" = ROUND("unitPrice"::numeric, 4),
  "totalPriceDecimal" = ROUND("totalPrice"::numeric, 4);

UPDATE "quotations"
SET
  "unitPriceDecimal" = ROUND("unitPrice"::numeric, 4),
  "totalPriceDecimal" = ROUND("totalPrice"::numeric, 4),
  "costPriceDecimal" = ROUND("costPrice"::numeric, 4);

UPDATE "orders"
SET
  "totalAmountDecimal" = ROUND("totalAmount"::numeric, 4),
  "importDutyDecimal" = CASE WHEN "importDuty" IS NULL THEN NULL ELSE ROUND("importDuty"::numeric, 4) END,
  "vatAmountDecimal" = CASE WHEN "vatAmount" IS NULL THEN NULL ELSE ROUND("vatAmount"::numeric, 4) END,
  "totalLandCostDecimal" = CASE WHEN "totalLandCost" IS NULL THEN NULL ELSE ROUND("totalLandCost"::numeric, 4) END,
  "exchangeCoreChargeDecimal" = CASE WHEN "exchangeCoreCharge" IS NULL THEN NULL ELSE ROUND("exchangeCoreCharge"::numeric, 4) END;
