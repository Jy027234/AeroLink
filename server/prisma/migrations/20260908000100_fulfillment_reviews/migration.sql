CREATE TABLE "fulfillment_reviews" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "inventoryDetailId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
  "approved" BOOLEAN NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "checks" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "reviewedById" TEXT NOT NULL,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "fulfillment_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fulfillment_reviews_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fulfillment_reviews_inventoryDetailId_fkey" FOREIGN KEY ("inventoryDetailId") REFERENCES "inventory_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fulfillment_reviews_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "fulfillment_reviews_orderId_inventoryDetailId_reviewedAt_idx" ON "fulfillment_reviews"("orderId", "inventoryDetailId", "reviewedAt");
