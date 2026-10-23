ALTER TABLE "ServerGroup" ADD COLUMN "defaults" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "ServerTag" ADD COLUMN "defaults" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Server" ADD COLUMN "overrides" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Server" ADD COLUMN "vcpu" INTEGER;
ALTER TABLE "Server" ADD COLUMN "ramBytes" DECIMAL;
ALTER TABLE "Server" ADD COLUMN "diskBytes" DECIMAL;
ALTER TABLE "Server" ADD COLUMN "os" TEXT;
ALTER TABLE "Server" ADD COLUMN "role" TEXT;
UPDATE "Server" SET "overrides" = json_object('identityId', "identityId", 'username', "username", 'environment', "environment", 'vpnProfileId', "vpnProfileId");
