-- Align PostgreSQL's 63-byte truncation with Prisma's generated index name.
ALTER INDEX "stock_receipts_purchaseCommitmentId_supplierDeliveryReference_k"
  RENAME TO "stock_receipts_purchaseCommitmentId_supplierDeliveryReferen_key";
