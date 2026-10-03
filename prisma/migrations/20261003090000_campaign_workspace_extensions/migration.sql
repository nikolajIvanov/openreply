-- Additive migration: preserve every existing campaign's sending state.
ALTER TABLE "Automation" ADD COLUMN "lifecycle" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "excludedKeywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "armedAt" TIMESTAMP(3), ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
UPDATE "Automation" SET "lifecycle" = CASE WHEN "isActive" THEN 'ACTIVE' ELSE 'PAUSED' END;
UPDATE "Automation" SET "armedAt" = "createdAt" WHERE "pendingNextReel" AND "isActive";
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_lifecycle_check" CHECK ("lifecycle" IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'));
-- A unique next-reel index would fail on pre-existing overlapping campaigns.
-- Both writers serialize on an account advisory lock instead; no rows are
-- silently paused or rebound by this migration.
CREATE TABLE "WorkspaceAsset" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "data" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkspaceAsset_workspaceId_kind_idx" ON "WorkspaceAsset"("workspaceId", "kind");
CREATE TABLE "ServiceKey" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL, "scopes" TEXT[], "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "ServiceKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ServiceKey_tokenHash_key" ON "ServiceKey"("tokenHash");
CREATE INDEX "ServiceKey_workspaceId_idx" ON "ServiceKey"("workspaceId");
CREATE TABLE "IntegrationEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "automationId" TEXT,
  "eventType" TEXT NOT NULL, "externalId" TEXT, "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IntegrationEvent_workspaceId_externalId_key" ON "IntegrationEvent"("workspaceId", "externalId");
CREATE INDEX "IntegrationEvent_workspaceId_createdAt_idx" ON "IntegrationEvent"("workspaceId", "createdAt");
CREATE TABLE "CampaignRevision" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "automationId" TEXT NOT NULL,
  "actorId" TEXT, "snapshot" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignRevision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CampaignRevision_workspaceId_automationId_createdAt_idx" ON "CampaignRevision"("workspaceId", "automationId", "createdAt");
CREATE TABLE "DeliveryEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "automationId" TEXT NOT NULL,
  "instagramAccountId" TEXT, "stage" TEXT NOT NULL, "operationKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "recipientId" TEXT, "message" TEXT,
  "campaignVersion" INTEGER NOT NULL DEFAULT 1, "payload" JSONB, "attempts" INTEGER NOT NULL DEFAULT 0,
  "scheduledAt" TIMESTAMP(3), "claimedAt" TIMESTAMP(3), "sentAt" TIMESTAMP(3), "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DeliveryEvent_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeliveryEvent_operationKey_key" ON "DeliveryEvent"("operationKey");
CREATE INDEX "DeliveryEvent_workspaceId_createdAt_idx" ON "DeliveryEvent"("workspaceId", "createdAt");
CREATE INDEX "DeliveryEvent_automationId_stage_idx" ON "DeliveryEvent"("automationId", "stage");
