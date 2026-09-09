-- Forward-only correction for 011: direct-shipment evidence is the ordered
-- non-empty fingerprint array consumed by directShipmentEvidence.ts.  The
-- already-deployed 011 migration is immutable.

ALTER TABLE "supplier_direct_shipments"
    DROP CONSTRAINT "supplier_direct_shipments_values_check";

ALTER TABLE "supplier_direct_shipments"
    ADD CONSTRAINT "supplier_direct_shipments_values_check" CHECK (
        length(btrim("id")) > 0
        AND length(btrim("shipmentNumber")) > 0
        AND length(btrim("carrier")) > 0
        AND length(btrim("trackingNumber")) > 0
        AND length(btrim("origin")) > 0
        AND length(btrim("destination")) > 0
        AND length(btrim("reason")) > 0
        AND length(btrim("commandId")) > 0
        AND length(btrim("requestHash")) > 0
        AND "version" > 0
        AND CASE
            WHEN jsonb_typeof("evidence") = 'array' THEN jsonb_array_length("evidence") > 0
            ELSE false
        END
        AND (("status" = 'PREPARED' AND "dispatchedById" IS NULL AND "dispatchedAt" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
             OR ("status" = 'CANCELLED' AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "dispatchedById" IS NULL AND "dispatchedAt" IS NULL)
             OR ("status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED') AND "dispatchedById" IS NOT NULL AND "dispatchedAt" IS NOT NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL))
    );
