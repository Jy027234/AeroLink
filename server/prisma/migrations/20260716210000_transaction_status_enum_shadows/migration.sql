-- P1-04 second slice: stable enum shadows for core transaction statuses.
-- Existing String columns remain the compatibility source until the later
-- read-cutover is explicitly approved.

CREATE TYPE "RfqStatusEnum" AS ENUM (
  'PENDING',
  'SOURCING',
  'QUOTING',
  'APPROVING',
  'ORDERED',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE "QuotationStatusEnum" AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SENT',
  'ACCEPTED',
  'EXPIRED',
  'WITHDRAWN'
);

CREATE TYPE "OrderStatusEnum" AS ENUM (
  'SO_CREATED',
  'PO_CREATED',
  'SHIPPED',
  'IN_TRANSIT',
  'CUSTOMS',
  'INSPECTION',
  'DELIVERED',
  'COMPLETED'
);

CREATE TYPE "SupplierQuoteStatusEnum" AS ENUM (
  'pending',
  'accepted',
  'rejected',
  'expired'
);

ALTER TABLE "rfqs"
  ADD COLUMN "statusEnum" "RfqStatusEnum";

ALTER TABLE "quotations"
  ADD COLUMN "statusEnum" "QuotationStatusEnum";

ALTER TABLE "orders"
  ADD COLUMN "statusEnum" "OrderStatusEnum";

ALTER TABLE "supplier_quotes"
  ADD COLUMN "statusEnum" "SupplierQuoteStatusEnum";

-- Backfill aliases using exactly the same canonical forms accepted by the
-- transaction state machines. Unknown legacy values deliberately remain NULL
-- and cause this migration to fail below rather than silently changing data.
UPDATE "rfqs"
SET "statusEnum" = CASE regexp_replace(upper(btrim("status")), '[-[:space:]]+', '_', 'g')
  WHEN 'PENDING' THEN 'PENDING'::"RfqStatusEnum"
  WHEN 'SOURCING' THEN 'SOURCING'::"RfqStatusEnum"
  WHEN 'QUOTING' THEN 'QUOTING'::"RfqStatusEnum"
  WHEN 'APPROVING' THEN 'APPROVING'::"RfqStatusEnum"
  WHEN 'APPROVED' THEN 'APPROVING'::"RfqStatusEnum"
  WHEN 'ORDERED' THEN 'ORDERED'::"RfqStatusEnum"
  WHEN 'SENT' THEN 'ORDERED'::"RfqStatusEnum"
  WHEN 'COMPLETED' THEN 'COMPLETED'::"RfqStatusEnum"
  WHEN 'WON' THEN 'COMPLETED'::"RfqStatusEnum"
  WHEN 'CANCELLED' THEN 'CANCELLED'::"RfqStatusEnum"
  WHEN 'CANCELED' THEN 'CANCELLED'::"RfqStatusEnum"
  WHEN 'LOST' THEN 'CANCELLED'::"RfqStatusEnum"
  ELSE NULL
END;

UPDATE "quotations"
SET "statusEnum" = CASE regexp_replace(upper(btrim("status")), '[-[:space:]]+', '_', 'g')
  WHEN 'DRAFT' THEN 'DRAFT'::"QuotationStatusEnum"
  WHEN 'PENDING_APPROVAL' THEN 'PENDING_APPROVAL'::"QuotationStatusEnum"
  WHEN 'PENDINGAPPROVAL' THEN 'PENDING_APPROVAL'::"QuotationStatusEnum"
  WHEN 'APPROVED' THEN 'APPROVED'::"QuotationStatusEnum"
  WHEN 'REJECTED' THEN 'REJECTED'::"QuotationStatusEnum"
  WHEN 'SENT' THEN 'SENT'::"QuotationStatusEnum"
  WHEN 'ACCEPTED' THEN 'ACCEPTED'::"QuotationStatusEnum"
  WHEN 'EXPIRED' THEN 'EXPIRED'::"QuotationStatusEnum"
  WHEN 'WITHDRAWN' THEN 'WITHDRAWN'::"QuotationStatusEnum"
  ELSE NULL
END;

UPDATE "orders"
SET "statusEnum" = CASE regexp_replace(upper(btrim("status")), '[-[:space:]]+', '_', 'g')
  WHEN 'SO_CREATED' THEN 'SO_CREATED'::"OrderStatusEnum"
  WHEN 'PO_CREATED' THEN 'PO_CREATED'::"OrderStatusEnum"
  WHEN 'SHIPPED' THEN 'SHIPPED'::"OrderStatusEnum"
  WHEN 'IN_TRANSIT' THEN 'IN_TRANSIT'::"OrderStatusEnum"
  WHEN 'CUSTOMS' THEN 'CUSTOMS'::"OrderStatusEnum"
  WHEN 'INSPECTION' THEN 'INSPECTION'::"OrderStatusEnum"
  WHEN 'DELIVERED' THEN 'DELIVERED'::"OrderStatusEnum"
  WHEN 'COMPLETED' THEN 'COMPLETED'::"OrderStatusEnum"
  ELSE NULL
END;

UPDATE "supplier_quotes"
SET "statusEnum" = CASE lower(btrim("status"))
  WHEN 'pending' THEN 'pending'::"SupplierQuoteStatusEnum"
  WHEN 'accepted' THEN 'accepted'::"SupplierQuoteStatusEnum"
  WHEN 'rejected' THEN 'rejected'::"SupplierQuoteStatusEnum"
  WHEN 'expired' THEN 'expired'::"SupplierQuoteStatusEnum"
  ELSE NULL
END;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "rfqs" WHERE "statusEnum" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill RFQ status enums: invalid legacy status found';
  END IF;
  IF EXISTS (SELECT 1 FROM "quotations" WHERE "statusEnum" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill quotation status enums: invalid legacy status found';
  END IF;
  IF EXISTS (SELECT 1 FROM "orders" WHERE "statusEnum" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill order status enums: invalid legacy status found';
  END IF;
  IF EXISTS (SELECT 1 FROM "supplier_quotes" WHERE "statusEnum" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill supplier quote status enums: invalid legacy status found';
  END IF;
END $$;
