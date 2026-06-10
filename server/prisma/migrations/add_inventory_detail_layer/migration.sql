-- Phase 3: 库存明细层迁移脚本
-- 将现有 Inventory 数据拆分到 InventoryItem（件号级）和 InventoryDetail（明细级）

-- 1. 创建件号级聚合数据（InventoryItem）
INSERT INTO "inventory_items" (
  "id", "partNumber", "description", "partCategory", "trackingType",
  "manufacturer", "manufacturerCageCode", "ataChapter", "alternatePartNumbers",
  "unitOfMeasure", "countryOfOrigin", "hsCode", "createdAt", "updatedAt"
)
SELECT 
  gen_random_uuid(),
  i."partNumber",
  MAX(i."description") as "description",
  MAX(i."partCategory") as "partCategory",
  MAX(i."trackingType") as "trackingType",
  MAX(i."manufacturer") as "manufacturer",
  MAX(i."manufacturerCageCode") as "manufacturerCageCode",
  MAX(i."ataChapter") as "ataChapter",
  MAX(i."alternatePartNumbers") as "alternatePartNumbers",
  MAX(i."unitOfMeasure") as "unitOfMeasure",
  MAX(i."countryOfOrigin") as "countryOfOrigin",
  MAX(i."hsCode") as "hsCode",
  MIN(i."createdAt") as "createdAt",
  MAX(i."updatedAt") as "updatedAt"
FROM "inventory" i
GROUP BY i."partNumber";

-- 2. 创建明细数据（InventoryDetail），关联到 InventoryItem
INSERT INTO "inventory_details" (
  "id", "inventoryItemId", "serialNumber", "batchNumber",
  "quantity", "conditionCode", "status",
  "warehouse", "shelf", "location",
  "certificateType", "certificateNumber", "certificateFileUrl",
  "lifeLimited", "totalHours", "remainingHours", "totalCycles", "remainingCycles",
  "manufactureDate", "shelfLifeDate", "overhaulDate", "nextOverhaulDue",
  "adStatus", "sbStatus", "repairScheme",
  "previousOperator", "removalAircraftReg", "removalDate", "removalReason",
  "nonIncidentStatement", "militarySource", "traceabilityDocs",
  "storageCondition", "ata300Packaging",
  "shelfLifeDays", "storageTempMin", "storageTempMax", "hazardClass",
  "unitCost", "supplierId", "eta", "type",
  "createdAt", "updatedAt"
)
SELECT 
  i."id",  -- 保留原 ID 以便证书等外键关联
  ii."id" as "inventoryItemId",
  i."serialNumber",
  i."batchNumber",
  i."quantity",
  i."conditionCode",
  'AVAILABLE' as "status",
  i."warehouse",
  i."shelf",
  i."location",
  i."certificateType",
  i."certificateNumber",
  i."certificateFileUrl",
  i."lifeLimited",
  i."totalHours",
  i."remainingHours",
  i."totalCycles",
  i."remainingCycles",
  i."manufactureDate",
  i."shelfLifeDate",
  i."overhaulDate",
  i."nextOverhaulDue",
  i."adStatus",
  i."sbStatus",
  i."repairScheme",
  i."previousOperator",
  i."removalAircraftReg",
  i."removalDate",
  i."removalReason",
  i."nonIncidentStatement",
  i."militarySource",
  i."traceabilityDocs",
  i."storageCondition",
  i."ata300Packaging",
  i."shelfLifeDays",
  i."storageTempMin",
  i."storageTempMax",
  i."hazardClass",
  i."unitCost",
  i."supplierId",
  i."eta",
  i."type",
  i."createdAt",
  i."updatedAt"
FROM "inventory" i
JOIN "inventory_items" ii ON ii."partNumber" = i."partNumber";

-- 3. 更新证书关联（将 inventoryId 映射到 inventoryDetailId）
-- 注意：由于 InventoryDetail 保留了原 Inventory 的 id，所以 inventoryId 可以直接作为 inventoryDetailId
UPDATE "certificates" c
SET "inventoryDetailId" = c."inventoryId"
WHERE c."inventoryId" IS NOT NULL;

-- 4. 验证数据一致性
-- SELECT COUNT(*) as total_items FROM "inventory_items";
-- SELECT COUNT(*) as total_details FROM "inventory_details";
-- SELECT COUNT(*) as original_inventory FROM "inventory";
