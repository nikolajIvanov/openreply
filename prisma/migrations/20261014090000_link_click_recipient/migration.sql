-- Additive: legacy clicks remain valid and require no backfill.
ALTER TABLE "LinkClick" ADD COLUMN IF NOT EXISTS "recipientHash" TEXT;
