-- AlterTable
ALTER TABLE "inventory" ADD COLUMN "partCategory" TEXT NOT NULL DEFAULT 'CONSUMABLE';
ALTER TABLE "inventory" ADD COLUMN "trackingType" TEXT NOT NULL DEFAULT 'BATCH';
ALTER TABLE "inventory" ADD COLUMN "shelfLifeDays" INTEGER;
ALTER TABLE "inventory" ADD COLUMN "storageTempMin" DOUBLE PRECISION;
ALTER TABLE "inventory" ADD COLUMN "storageTempMax" DOUBLE PRECISION;
ALTER TABLE "inventory" ADD COLUMN "hazardClass" TEXT;
