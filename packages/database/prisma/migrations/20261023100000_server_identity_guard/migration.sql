-- Legacy duplicate rows remain untouched. SQLite serializes writers, so these
-- triggers reject any new collision even when requests race across processes.
CREATE INDEX "Server_canonical_identity_idx" ON "Server"(
  "organizationId", lower(rtrim(trim("host"), '.')), "port", "groupId"
);

CREATE TRIGGER "Server_identity_insert" BEFORE INSERT ON "Server"
WHEN EXISTS (
  SELECT 1 FROM "Server" AS existing
  WHERE existing."organizationId" = NEW."organizationId"
    AND lower(rtrim(trim(existing."host"), '.')) = lower(rtrim(trim(NEW."host"), '.'))
    AND existing."port" = NEW."port"
    AND existing."groupId" IS NEW."groupId"
)
BEGIN
  SELECT RAISE(ABORT, 'server_identity_conflict');
END;

CREATE TRIGGER "Server_identity_update" BEFORE UPDATE OF "organizationId", "host", "port", "groupId" ON "Server"
WHEN (
  OLD."organizationId" IS NOT NEW."organizationId"
  OR lower(rtrim(trim(OLD."host"), '.')) IS NOT lower(rtrim(trim(NEW."host"), '.'))
  OR OLD."port" IS NOT NEW."port"
  OR OLD."groupId" IS NOT NEW."groupId"
) AND EXISTS (
  SELECT 1 FROM "Server" AS existing
  WHERE existing."id" <> OLD."id"
    AND existing."organizationId" = NEW."organizationId"
    AND lower(rtrim(trim(existing."host"), '.')) = lower(rtrim(trim(NEW."host"), '.'))
    AND existing."port" = NEW."port"
    AND existing."groupId" IS NEW."groupId"
)
BEGIN
  SELECT RAISE(ABORT, 'server_identity_conflict');
END;
