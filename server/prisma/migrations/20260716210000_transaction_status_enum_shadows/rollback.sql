-- Manual rollback for P1-04's transaction status enum shadows.
--
-- Run only after rolling application code back to a version that does not
-- dual-write or read these enum shadows. Legacy String status columns and
-- transaction history remain untouched.

ALTER TABLE "supplier_quotes" DROP COLUMN IF EXISTS "statusEnum";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "statusEnum";
ALTER TABLE "quotations" DROP COLUMN IF EXISTS "statusEnum";
ALTER TABLE "rfqs" DROP COLUMN IF EXISTS "statusEnum";

DROP TYPE IF EXISTS "SupplierQuoteStatusEnum";
DROP TYPE IF EXISTS "OrderStatusEnum";
DROP TYPE IF EXISTS "QuotationStatusEnum";
DROP TYPE IF EXISTS "RfqStatusEnum";
