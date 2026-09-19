-- D10 M1: add transaction line tables and nullable source-row links.
-- Legacy header fields remain intact. No historical line rows are created here;
-- the strict, repeatable backfill script performs that work only after a
-- read-only preflight has passed.

CREATE TABLE "rfq_lines" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "partNumber" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "conditionCode" TEXT NOT NULL DEFAULT 'NE',
    "description" TEXT,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "alternatePartNumbers" TEXT,
    "certificateRequired" BOOLEAN NOT NULL DEFAULT true,
    "certificateType" TEXT,
    "requiredDate" TIMESTAMP(3) NOT NULL,
    "leadTimeDays" INTEGER,
    "targetPriceDecimal" DECIMAL(18, 4),
    "targetPriceCurrency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfq_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rfq_lines_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "rfq_lines_lineNo_check" CHECK ("lineNo" > 0),
    CONSTRAINT "rfq_lines_status_check" CHECK ("status" IN ('OPEN', 'CANCELLED', 'COMPLETED'))
);

CREATE TABLE "quotation_lines" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "rfqLineId" TEXT NOT NULL,
    "sourceSupplierQuoteId" TEXT,
    "partNumber" TEXT NOT NULL,
    "description" TEXT,
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18, 4) NOT NULL,
    "costPrice" DECIMAL(18, 4) NOT NULL,
    "lineTotal" DECIMAL(18, 4) NOT NULL,
    "marginAmount" DECIMAL(18, 4) NOT NULL,
    "marginPercent" DECIMAL(9, 4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "acceptedQuantity" INTEGER NOT NULL DEFAULT 0,
    "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
    "inventoryDetailId" TEXT,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quotation_lines_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "quotation_lines_lineNo_check" CHECK ("lineNo" > 0),
    CONSTRAINT "quotation_lines_acceptedQuantity_check" CHECK ("acceptedQuantity" >= 0 AND "acceptedQuantity" <= "quantity"),
    CONSTRAINT "quotation_lines_reservedQuantity_check" CHECK ("reservedQuantity" >= 0 AND "reservedQuantity" <= "quantity"),
    CONSTRAINT "quotation_lines_status_check" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_ACCEPTED', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT "quotation_lines_currency_check" CHECK ("currency" = 'USD')
);

CREATE TABLE "order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "quotationLineId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18, 4) NOT NULL,
    "lineTotal" DECIMAL(18, 4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "outboundQuantity" INTEGER NOT NULL DEFAULT 0,
    "outboundStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "inventoryDetailId" TEXT,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_lines_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "order_lines_lineNo_check" CHECK ("lineNo" > 0),
    CONSTRAINT "order_lines_outboundQuantity_check" CHECK ("outboundQuantity" >= 0 AND "outboundQuantity" <= "quantity"),
    CONSTRAINT "order_lines_outboundStatus_check" CHECK ("outboundStatus" IN ('PENDING', 'PARTIAL', 'COMPLETED')),
    CONSTRAINT "order_lines_currency_check" CHECK ("currency" = 'USD')
);

ALTER TABLE "inquiries" ADD COLUMN "rfqId" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "notes" TEXT;
ALTER TABLE "inquiry_items" ADD COLUMN "lineNo" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "inquiry_items" ADD COLUMN "rfqLineId" TEXT;
ALTER TABLE "supplier_quotes" ADD COLUMN "rfqLineId" TEXT;
ALTER TABLE "supplier_quotes" ADD COLUMN "inquiryItemId" TEXT;

-- Historical inquiries did not persist a line number. This deterministic
-- compatibility numbering only makes the new uniqueness invariant possible;
-- it does not infer any RFQ/source relationship.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "inquiryId" ORDER BY "id")::INTEGER AS "lineNo"
  FROM "inquiry_items"
)
UPDATE "inquiry_items" AS item
SET "lineNo" = ranked."lineNo"
FROM ranked
WHERE item."id" = ranked."id";

CREATE UNIQUE INDEX "rfq_lines_rfqId_lineNo_key" ON "rfq_lines"("rfqId", "lineNo");
CREATE INDEX "rfq_lines_rfqId_status_idx" ON "rfq_lines"("rfqId", "status");
CREATE UNIQUE INDEX "inquiry_items_inquiryId_lineNo_key" ON "inquiry_items"("inquiryId", "lineNo");
CREATE INDEX "inquiry_items_rfqLineId_idx" ON "inquiry_items"("rfqLineId");
CREATE INDEX "inquiries_rfqId_supplierId_idx" ON "inquiries"("rfqId", "supplierId");
CREATE INDEX "supplier_quotes_rfqLineId_supplierId_status_idx" ON "supplier_quotes"("rfqLineId", "supplierId", "status");
CREATE INDEX "supplier_quotes_inquiryItemId_supplierId_status_idx" ON "supplier_quotes"("inquiryItemId", "supplierId", "status");
CREATE UNIQUE INDEX "quotation_lines_quotationId_lineNo_key" ON "quotation_lines"("quotationId", "lineNo");
CREATE INDEX "quotation_lines_rfqLineId_idx" ON "quotation_lines"("rfqLineId");
CREATE INDEX "quotation_lines_sourceSupplierQuoteId_idx" ON "quotation_lines"("sourceSupplierQuoteId");
CREATE UNIQUE INDEX "order_lines_orderId_lineNo_key" ON "order_lines"("orderId", "lineNo");
CREATE INDEX "order_lines_quotationLineId_idx" ON "order_lines"("quotationLineId");

ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_rfqId_fkey"
  FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_rfqId_fkey"
  FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inquiry_items" ADD CONSTRAINT "inquiry_items_rfqLineId_fkey"
  FOREIGN KEY ("rfqLineId") REFERENCES "rfq_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_rfqLineId_fkey"
  FOREIGN KEY ("rfqLineId") REFERENCES "rfq_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_inquiryItemId_fkey"
  FOREIGN KEY ("inquiryItemId") REFERENCES "inquiry_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotationId_fkey"
  FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_rfqLineId_fkey"
  FOREIGN KEY ("rfqLineId") REFERENCES "rfq_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_sourceSupplierQuoteId_fkey"
  FOREIGN KEY ("sourceSupplierQuoteId") REFERENCES "supplier_quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_quotationLineId_fkey"
  FOREIGN KEY ("quotationLineId") REFERENCES "quotation_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
