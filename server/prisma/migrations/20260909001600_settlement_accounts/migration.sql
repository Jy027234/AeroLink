-- D14 settlement accounts and immutable external settlement records.
--
-- This migration creates only the settlement account/record facts.  It does
-- not create a ledger, tax rows, FX rows, bank actions, or historical
-- backfills.  Commands must append one record and advance account.version in
-- the same transaction; the deferred account trigger validates the final
-- sequence and derived limits at commit.

CREATE TYPE "SettlementSide" AS ENUM (
  'RECEIVABLE',
  'PAYABLE'
);

CREATE TYPE "SettlementRecordKind" AS ENUM (
  'OPEN',
  'TERMS',
  'PAYMENT',
  'CREDIT',
  'REFUND',
  'REVERSAL'
);

CREATE TABLE "settlement_accounts" (
  "id" TEXT NOT NULL,
  "side" "SettlementSide" NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "purchaseCommitmentId" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "initialAmount" DECIMAL(18,4) NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "settlement_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "settlement_accounts_values_check" CHECK (
    length(btrim("id")) > 0
    AND length(btrim("sourceKey")) > 0
    AND "currency" = 'USD'
    AND "initialAmount" BETWEEN 0 AND 99999999999999.9999
    AND "version" > 0
    AND jsonb_typeof("sourceSnapshot") = 'object'
    AND "sourceSnapshot"->>'kind' IS NOT NULL
    AND "sourceSnapshot"->>'sourceId' IS NOT NULL
    AND "sourceSnapshot"->>'sourceNumber' IS NOT NULL
    AND "sourceSnapshot"->>'sourceVersion' IS NOT NULL
    AND "sourceSnapshot"->>'initialAmount' IS NOT NULL
    AND "sourceSnapshot"->>'currency' IS NOT NULL
    AND "sourceSnapshot"->>'currency' = 'USD'
  )
);

CREATE TABLE "settlement_records" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "kind" "SettlementRecordKind" NOT NULL,
  "accountVersion" INTEGER NOT NULL,
  "amount" DECIMAL(18,4),
  "dueDate" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "externalSystem" TEXT NOT NULL,
  "voucherNumber" TEXT NOT NULL,
  "voucherLine" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "reversalOfId" TEXT,
  "actorId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "settlement_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "settlement_records_values_check" CHECK (
    length(btrim("id")) > 0
    AND "accountVersion" > 0
    AND "externalSystem" = btrim("externalSystem")
    AND length(btrim("externalSystem")) > 0
    AND "voucherNumber" = btrim("voucherNumber")
    AND length(btrim("voucherNumber")) > 0
    AND "voucherLine" = btrim("voucherLine")
    AND length(btrim("voucherLine")) > 0
    AND "reason" = btrim("reason")
    AND length(btrim("reason")) > 0
    AND length(btrim("actorId")) > 0
    AND length(btrim("commandId")) > 0
    AND "requestHash" ~ '^[0-9a-fA-F]{64}$'
    AND jsonb_typeof("evidence") = 'array'
    AND (
      ("kind" IN ('OPEN', 'TERMS')
        AND "amount" IS NULL
        AND "dueDate" IS NOT NULL
        AND "reversalOfId" IS NULL)
      OR ("kind" IN ('PAYMENT', 'CREDIT', 'REFUND')
        AND "amount" IS NOT NULL
        AND "amount" > 0 AND "amount" <= 99999999999999.9999
        AND "dueDate" IS NULL
        AND "reversalOfId" IS NULL)
      OR ("kind" = 'REVERSAL'
        AND "amount" IS NOT NULL
        AND "amount" > 0 AND "amount" <= 99999999999999.9999
        AND "dueDate" IS NULL
        AND "reversalOfId" IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX "settlement_accounts_sourceKey_key"
  ON "settlement_accounts"("sourceKey");
CREATE UNIQUE INDEX "settlement_accounts_purchaseCommitmentId_key"
  ON "settlement_accounts"("purchaseCommitmentId");
CREATE INDEX "settlement_accounts_orderId_side_idx"
  ON "settlement_accounts"("orderId", "side");
CREATE INDEX "settlement_accounts_createdById_createdAt_idx"
  ON "settlement_accounts"("createdById", "createdAt");

CREATE UNIQUE INDEX "settlement_records_accountId_accountVersion_key"
  ON "settlement_records"("accountId", "accountVersion");
CREATE UNIQUE INDEX "settlement_records_external_voucher_key"
  ON "settlement_records"("externalSystem", "voucherNumber", "voucherLine");
CREATE UNIQUE INDEX "settlement_records_reversal_of_key"
  ON "settlement_records"("reversalOfId");
CREATE UNIQUE INDEX "settlement_records_commandId_key"
  ON "settlement_records"("commandId");
CREATE INDEX "settlement_records_accountId_occurredAt_idx"
  ON "settlement_records"("accountId", "occurredAt");
CREATE INDEX "settlement_records_actorId_occurredAt_idx"
  ON "settlement_records"("actorId", "occurredAt");

ALTER TABLE "settlement_accounts"
  ADD CONSTRAINT "settlement_accounts_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "settlement_accounts_purchaseCommitmentId_fkey"
    FOREIGN KEY ("purchaseCommitmentId") REFERENCES "purchase_commitments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "settlement_accounts_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "settlement_records"
  ADD CONSTRAINT "settlement_records_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "settlement_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "settlement_records_reversalOfId_fkey"
    FOREIGN KEY ("reversalOfId") REFERENCES "settlement_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "settlement_records_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Account source and AR/AP identity are checked at creation.  The source
-- fields are immutable afterwards; later quotation/purchase changes do not
-- rewrite a historical account or make its records disappear.
CREATE OR REPLACE FUNCTION validate_settlement_account_write_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_quotation_id TEXT;
    v_order_total DECIMAL(18,4);
    v_order_number TEXT;
    v_order_customer_id TEXT;
    v_order_customer_name TEXT;
    v_order_line_items_mode BOOLEAN;
    v_order_status TEXT;
    v_quote_currency TEXT;
    v_purchase_order_id TEXT;
    v_purchase_number TEXT;
    v_purchase_supplier_id TEXT;
    v_purchase_supplier_name TEXT;
    v_purchase_order_line_items_mode BOOLEAN;
    v_purchase_order_status TEXT;
    v_purchase_quote_currency TEXT;
    v_purchase_currency TEXT;
    v_purchase_total DECIMAL(18,4);
    v_purchase_status TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Settlement accounts are immutable; use records and REVERSAL'
          USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."side" IS DISTINCT FROM OLD."side"
           OR NEW."sourceKey" IS DISTINCT FROM OLD."sourceKey"
           OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
           OR NEW."purchaseCommitmentId" IS DISTINCT FROM OLD."purchaseCommitmentId"
           OR NEW."currency" IS DISTINCT FROM OLD."currency"
           OR NEW."initialAmount" IS DISTINCT FROM OLD."initialAmount"
           OR NEW."sourceSnapshot" IS DISTINCT FROM OLD."sourceSnapshot"
           OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
            RAISE EXCEPTION 'Settlement account source facts are immutable'
              USING ERRCODE = '55000';
        END IF;
        IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
            RAISE EXCEPTION 'Settlement account version must advance by at most one'
              USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."purchaseCommitmentId" IS NULL THEN
        IF NEW."side" <> 'RECEIVABLE'
           OR NEW."sourceKey" <> 'ORDER:' || NEW."orderId"
           OR NEW."sourceSnapshot"->>'kind' <> 'ORDER'
           OR NEW."sourceSnapshot"->>'sourceId' <> NEW."orderId" THEN
            RAISE EXCEPTION 'Receivable settlement account source is invalid'
              USING ERRCODE = '23514';
        END IF;

        SELECT o."quotationId", o."totalAmountDecimal", o."orderNumber", o."customerId",
               c."name", o."lineItemsMode", COALESCE(o."statusEnum"::text, o."status")
          INTO v_quotation_id, v_order_total, v_order_number, v_order_customer_id,
               v_order_customer_name, v_order_line_items_mode, v_order_status
          FROM "orders" o
          JOIN "customers" c ON c."id" = o."customerId"
         WHERE o."id" = NEW."orderId";
        IF NOT FOUND OR v_order_total IS NULL
           OR v_order_line_items_mode IS NOT TRUE
           OR upper(v_order_status) NOT IN ('SO_CREATED', 'PO_CREATED', 'SHIPPED', 'DELIVERED') THEN
            RAISE EXCEPTION 'Receivable settlement requires a modern active sales order with an explicit Decimal total'
              USING ERRCODE = '23514';
        END IF;
        IF NEW."initialAmount" <> v_order_total THEN
            RAISE EXCEPTION 'Receivable settlement amount must equal order Decimal total'
              USING ERRCODE = '23514';
        END IF;

        SELECT q."currency"
          INTO v_quote_currency
          FROM "quotations" q
         WHERE q."id" = v_quotation_id;
        IF NOT FOUND OR v_quote_currency <> 'USD' THEN
            RAISE EXCEPTION 'Receivable settlement requires a USD quotation'
              USING ERRCODE = '23514';
        END IF;
        IF NEW."sourceSnapshot"->>'sourceNumber' IS DISTINCT FROM v_order_number
           OR NEW."sourceSnapshot"->>'counterpartyId' IS DISTINCT FROM v_order_customer_id
           OR NEW."sourceSnapshot"->>'counterpartyName' IS DISTINCT FROM v_order_customer_name THEN
            RAISE EXCEPTION 'Receivable settlement source snapshot does not match the sales order'
              USING ERRCODE = '23514';
        END IF;
        IF NEW."sourceSnapshot"->>'initialAmount' !~ '^[0-9]+(\.[0-9]{1,4})?$'
           OR (NEW."sourceSnapshot"->>'initialAmount')::numeric <> NEW."initialAmount" THEN
            RAISE EXCEPTION 'Receivable settlement source snapshot amount does not match the order'
              USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NEW."side" <> 'PAYABLE'
           OR NEW."sourceKey" <> 'PURCHASE:' || NEW."purchaseCommitmentId"
           OR NEW."sourceSnapshot"->>'kind' <> 'PURCHASE'
           OR NEW."sourceSnapshot"->>'sourceId' <> NEW."purchaseCommitmentId" THEN
            RAISE EXCEPTION 'Payable settlement account source is invalid'
              USING ERRCODE = '23514';
        END IF;

        SELECT p."orderId", p."commitmentNumber", p."supplierId", s."name",
               p."currency", p."totalCost", p."status"::text,
               o."lineItemsMode", COALESCE(o."statusEnum"::text, o."status"), q."currency"
          INTO v_purchase_order_id, v_purchase_number, v_purchase_supplier_id, v_purchase_supplier_name,
               v_purchase_currency, v_purchase_total, v_purchase_status,
               v_purchase_order_line_items_mode, v_purchase_order_status, v_purchase_quote_currency
          FROM "purchase_commitments" p
          JOIN "suppliers" s ON s."id" = p."supplierId"
          JOIN "orders" o ON o."id" = p."orderId"
          JOIN "quotations" q ON q."id" = o."quotationId"
         WHERE p."id" = NEW."purchaseCommitmentId";
        IF NOT FOUND
           OR v_purchase_order_id <> NEW."orderId"
           OR v_purchase_currency <> 'USD'
           OR v_purchase_status NOT IN ('CONFIRMED', 'CLOSED')
           OR v_purchase_order_line_items_mode IS NOT TRUE
           OR upper(v_purchase_order_status) NOT IN ('SO_CREATED', 'PO_CREATED', 'SHIPPED', 'DELIVERED')
           OR v_purchase_quote_currency <> 'USD' THEN
            RAISE EXCEPTION 'Payable settlement requires a confirmed or closed USD purchase for the same modern order'
              USING ERRCODE = '23514';
        END IF;
        IF NEW."initialAmount" <> v_purchase_total THEN
            RAISE EXCEPTION 'Payable settlement amount must equal purchase total cost'
              USING ERRCODE = '23514';
        END IF;
        IF NEW."sourceSnapshot"->>'sourceNumber' IS DISTINCT FROM v_purchase_number
           OR NEW."sourceSnapshot"->>'counterpartyId' IS DISTINCT FROM v_purchase_supplier_id
           OR NEW."sourceSnapshot"->>'counterpartyName' IS DISTINCT FROM v_purchase_supplier_name THEN
            RAISE EXCEPTION 'Payable settlement source snapshot does not match the purchase'
              USING ERRCODE = '23514';
        END IF;
        IF NEW."sourceSnapshot"->>'initialAmount' !~ '^[0-9]+(\.[0-9]{1,4})?$'
           OR (NEW."sourceSnapshot"->>'initialAmount')::numeric <> NEW."initialAmount" THEN
            RAISE EXCEPTION 'Payable settlement source snapshot amount does not match the purchase'
              USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Records are append-only.  A reversal is a new record that points to one
-- original cash/credit/refund record and carries the exact same amount.
CREATE OR REPLACE FUNCTION validate_settlement_record_insert_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_account_id TEXT;
    v_target_kind TEXT;
    v_target_amount DECIMAL(18,4);
    v_target_version INTEGER;
    v_evidence_count INTEGER;
    v_distinct_id_count INTEGER;
    v_distinct_fingerprint_count INTEGER;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Settlement records are append-only; use REVERSAL'
          USING ERRCODE = '55000';
    END IF;

    IF NEW."kind" = 'REVERSAL' THEN
        SELECT r."accountId", r."kind"::text, r."amount", r."accountVersion"
          INTO v_target_account_id, v_target_kind, v_target_amount, v_target_version
          FROM "settlement_records" r
         WHERE r."id" = NEW."reversalOfId";
        IF NOT FOUND
           OR v_target_account_id <> NEW."accountId"
           OR v_target_kind NOT IN ('PAYMENT', 'CREDIT', 'REFUND')
           OR v_target_amount IS NULL
           OR NEW."amount" IS DISTINCT FROM v_target_amount
           OR NEW."accountVersion" <= v_target_version THEN
            RAISE EXCEPTION 'Settlement reversal must target the same account with an equal full cash/credit/refund amount'
              USING ERRCODE = '23514';
        END IF;
    END IF;

    SELECT jsonb_array_length(NEW."evidence")
      INTO v_evidence_count;
    IF v_evidence_count < 1 OR v_evidence_count > 20 THEN
        RAISE EXCEPTION 'Each settlement record requires one to twenty evidence attachments'
          USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(NEW."evidence") item
         WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
            OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
            OR length(btrim(item->>'id')) = 0
            OR jsonb_typeof(item->'version') IS DISTINCT FROM 'number'
            OR item->>'version' !~ '^[1-9][0-9]*$'
            OR jsonb_typeof(item->'sha256') IS DISTINCT FROM 'string'
            OR item->>'sha256' !~ '^[0-9a-fA-F]{64}$'
            OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string'
            OR item->>'status' <> 'AVAILABLE'
    ) THEN
        RAISE EXCEPTION 'Settlement evidence must contain valid AVAILABLE id/version/sha256 fingerprints'
          USING ERRCODE = '23514';
    END IF;
    SELECT COUNT(*)::INTEGER,
           COUNT(DISTINCT item->>'id')::INTEGER,
           COUNT(DISTINCT (item->>'id') || ':' || (item->>'version') || ':' || (item->>'sha256'))::INTEGER
      INTO v_evidence_count, v_distinct_id_count, v_distinct_fingerprint_count
      FROM jsonb_array_elements(NEW."evidence") item;
    IF v_evidence_count <> v_distinct_id_count
       OR v_evidence_count <> v_distinct_fingerprint_count THEN
        RAISE EXCEPTION 'Settlement evidence attachments must be unique'
          USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(NEW."evidence") item
          LEFT JOIN "stored_objects" stored
            ON stored."id" = item->>'id'
           AND stored."status" = 'AVAILABLE'
           AND stored."domain" = 'settlement_account'
           AND stored."resourceId" = NEW."accountId"
           AND stored."version"::numeric = (item->>'version')::numeric
           AND stored."sha256" = item->>'sha256'
           AND stored."ownerId" = NEW."actorId"
         WHERE stored."id" IS NULL
    ) THEN
        RAISE EXCEPTION 'Settlement evidence is unavailable, stale, unowned, or bound to another account'
          USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

-- This deferred validator is intentionally derived from immutable records.
-- It permits command-level intermediate states (CAS account version first or
-- record first) while rejecting any transaction that commits a gap, changes
-- the due-date projection, or exceeds effective credit/refund limits.
CREATE OR REPLACE FUNCTION validate_settlement_account_state_v1(p_account_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_account_version INTEGER;
    v_initial_amount DECIMAL(18,4);
    v_account_due_date TIMESTAMP(3);
    v_record_count INTEGER;
    v_latest_due_date TIMESTAMP(3);
    v_credits DECIMAL(30,4);
    v_payments DECIMAL(30,4);
    v_refunds DECIMAL(30,4);
BEGIN
    SELECT a."version", a."initialAmount", a."dueDate"
      INTO v_account_version, v_initial_amount, v_account_due_date
      FROM "settlement_accounts" a
     WHERE a."id" = p_account_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT COUNT(*)::INTEGER
      INTO v_record_count
      FROM "settlement_records" r
     WHERE r."accountId" = p_account_id;
    IF v_record_count <> v_account_version THEN
        RAISE EXCEPTION 'Settlement account version does not equal record count'
          USING ERRCODE = '23514';
    END IF;
    IF v_record_count = 0 THEN
        RAISE EXCEPTION 'Settlement account requires an OPEN record'
          USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM generate_series(1, v_account_version) expected(version)
          LEFT JOIN "settlement_records" r
            ON r."accountId" = p_account_id
           AND r."accountVersion" = expected.version
         WHERE r."id" IS NULL
    ) THEN
        RAISE EXCEPTION 'Settlement record versions must be contiguous from one'
          USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "settlement_records" r
         WHERE r."accountId" = p_account_id
           AND r."accountVersion" = 1
           AND r."kind" = 'OPEN'
    ) OR EXISTS (
        SELECT 1 FROM "settlement_records" r
         WHERE r."accountId" = p_account_id
           AND r."kind" = 'OPEN'
           AND r."accountVersion" <> 1
    ) THEN
        RAISE EXCEPTION 'Settlement records must contain exactly one version-one OPEN record'
          USING ERRCODE = '23514';
    END IF;

    SELECT r."dueDate"
      INTO v_latest_due_date
      FROM "settlement_records" r
     WHERE r."accountId" = p_account_id
       AND r."kind" IN ('OPEN', 'TERMS')
     ORDER BY r."accountVersion" DESC
     LIMIT 1;
    IF v_account_due_date IS DISTINCT FROM v_latest_due_date THEN
        RAISE EXCEPTION 'Settlement account dueDate must match the latest OPEN or TERMS record'
          USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(r."amount"), 0)
      INTO v_credits
      FROM "settlement_records" r
     WHERE r."accountId" = p_account_id
       AND r."kind" = 'CREDIT'
       AND NOT EXISTS (
         SELECT 1 FROM "settlement_records" reversal
          WHERE reversal."reversalOfId" = r."id"
       );
    IF v_credits > v_initial_amount THEN
        RAISE EXCEPTION 'Effective credits exceed settlement initial amount'
          USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(r."amount"), 0)
      INTO v_payments
      FROM "settlement_records" r
     WHERE r."accountId" = p_account_id
       AND r."kind" = 'PAYMENT'
       AND NOT EXISTS (
         SELECT 1 FROM "settlement_records" reversal
          WHERE reversal."reversalOfId" = r."id"
       );
    SELECT COALESCE(SUM(r."amount"), 0)
      INTO v_refunds
      FROM "settlement_records" r
     WHERE r."accountId" = p_account_id
       AND r."kind" = 'REFUND'
       AND NOT EXISTS (
         SELECT 1 FROM "settlement_records" reversal
          WHERE reversal."reversalOfId" = r."id"
       );
    IF v_refunds > v_payments THEN
        RAISE EXCEPTION 'Effective refunds exceed effective payments'
          USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_settlement_account_state_trigger_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM validate_settlement_account_state_v1(
      CASE WHEN TG_OP = 'DELETE' THEN OLD."accountId" ELSE NEW."accountId" END
    );
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_settlement_account_constraint_trigger_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM validate_settlement_account_state_v1(NEW."id");
    RETURN NULL;
END;
$$;

CREATE TRIGGER settlement_account_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "settlement_accounts"
  FOR EACH ROW EXECUTE FUNCTION validate_settlement_account_write_v1();

CREATE TRIGGER settlement_record_insert_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "settlement_records"
  FOR EACH ROW EXECUTE FUNCTION validate_settlement_record_insert_v1();

CREATE CONSTRAINT TRIGGER settlement_account_state_guard
  AFTER INSERT OR UPDATE ON "settlement_accounts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_settlement_account_constraint_trigger_v1();

CREATE CONSTRAINT TRIGGER settlement_record_state_guard
  AFTER INSERT OR UPDATE OR DELETE ON "settlement_records"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_settlement_account_state_trigger_v1();
