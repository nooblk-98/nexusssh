CREATE TABLE "VpnProfile" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 "organizationId" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "description" TEXT NOT NULL DEFAULT '',
 "encryptedConfig" TEXT NOT NULL,
 "summary" TEXT NOT NULL,
 CONSTRAINT "VpnProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "VpnProfile_organizationId_idx" ON "VpnProfile"("organizationId");
ALTER TABLE "Server" ADD COLUMN "vpnProfileId" TEXT REFERENCES "VpnProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
