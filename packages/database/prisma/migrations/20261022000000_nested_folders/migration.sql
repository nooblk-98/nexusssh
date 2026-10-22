ALTER TABLE "ServerGroup" ADD COLUMN "parentId" TEXT REFERENCES "ServerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX "ServerGroup_organizationId_name_key";
CREATE UNIQUE INDEX "ServerGroup_organizationId_parentId_name_key" ON "ServerGroup"("organizationId", "parentId", "name");
-- SQLite treats NULL values as distinct in compound unique indexes.
CREATE UNIQUE INDEX "ServerGroup_root_name_key" ON "ServerGroup"("organizationId", "name") WHERE "parentId" IS NULL;
CREATE INDEX "ServerGroup_parentId_idx" ON "ServerGroup"("parentId");
