-- Archiving is how servers are deleted, so an archived server must not block
-- re-adding the same host and port to its folder or emptying a deleted folder.
-- Only active servers are compared; restoring an archived server is checked too.
DROP TRIGGER IF EXISTS "Server_identity_insert";
DROP TRIGGER IF EXISTS "Server_identity_update";

CREATE TRIGGER "Server_identity_insert" BEFORE INSERT ON "Server"
WHEN NEW."archived" = 0 AND EXISTS (
  SELECT 1 FROM "Server" AS existing
  WHERE existing."archived" = 0
    AND existing."organizationId" = NEW."organizationId"
    AND lower(rtrim(trim(existing."host"), '.')) = lower(rtrim(trim(NEW."host"), '.'))
    AND existing."port" = NEW."port"
    AND existing."groupId" IS NEW."groupId"
)
BEGIN
  SELECT RAISE(ABORT, 'server_identity_conflict');
END;

CREATE TRIGGER "Server_identity_update" BEFORE UPDATE OF "organizationId", "host", "port", "groupId", "archived" ON "Server"
WHEN NEW."archived" = 0 AND (
  OLD."archived" IS NOT NEW."archived"
  OR OLD."organizationId" IS NOT NEW."organizationId"
  OR lower(rtrim(trim(OLD."host"), '.')) IS NOT lower(rtrim(trim(NEW."host"), '.'))
  OR OLD."port" IS NOT NEW."port"
  OR OLD."groupId" IS NOT NEW."groupId"
) AND EXISTS (
  SELECT 1 FROM "Server" AS existing
  WHERE existing."id" <> OLD."id"
    AND existing."archived" = 0
    AND existing."organizationId" = NEW."organizationId"
    AND lower(rtrim(trim(existing."host"), '.')) = lower(rtrim(trim(NEW."host"), '.'))
    AND existing."port" = NEW."port"
    AND existing."groupId" IS NEW."groupId"
)
BEGIN
  SELECT RAISE(ABORT, 'server_identity_conflict');
END;
