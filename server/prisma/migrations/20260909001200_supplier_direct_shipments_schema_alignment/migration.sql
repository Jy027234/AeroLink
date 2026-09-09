-- Forward-only metadata alignment for 011.
-- 011 is already deployed and therefore remains immutable. These names match
-- Prisma's generated names for the schema indexes, and @updatedAt fields do
-- not declare a database default.

ALTER INDEX "supplier_direct_shipment_events_actor_created_idx"
    RENAME TO "supplier_direct_shipment_events_actorId_createdAt_idx";
ALTER INDEX "supplier_direct_shipment_events_line_created_idx"
    RENAME TO "supplier_direct_shipment_events_shipmentLineId_createdAt_idx";
ALTER INDEX "supplier_direct_shipment_events_shipment_event_idx"
    RENAME TO "supplier_direct_shipment_events_shipmentId_eventNo_idx";
ALTER INDEX "supplier_direct_shipment_lines_purchase_review_idx"
    RENAME TO "supplier_direct_shipment_lines_purchaseCommitmentLineId_rev_idx";
ALTER INDEX "supplier_direct_shipment_lines_shipment_review_idx"
    RENAME TO "supplier_direct_shipment_lines_shipmentId_reviewStatus_idx";
ALTER INDEX "supplier_direct_shipments_order_status_idx"
    RENAME TO "supplier_direct_shipments_orderId_status_idx";
ALTER INDEX "supplier_direct_shipments_purchase_status_idx"
    RENAME TO "supplier_direct_shipments_purchaseCommitmentId_status_idx";

ALTER TABLE "supplier_direct_shipment_lines"
    ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "supplier_direct_shipments"
    ALTER COLUMN "updatedAt" DROP DEFAULT;
