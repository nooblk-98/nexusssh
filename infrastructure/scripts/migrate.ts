import "dotenv/config";
import { openSync, closeSync, mkdirSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
const url = process.env.DATABASE_URL;
if (!url?.startsWith("file:"))
  throw new Error("DATABASE_URL must be a SQLite file URL");
const location = url.slice(5);
const path = isAbsolute(location)
  ? location
  : resolve("packages/database/prisma", location);
mkdirSync(dirname(path), { recursive: true });
closeSync(openSync(path, "a", 0o600));
const result = spawnSync(
  process.execPath,
  [
    "node_modules/prisma/build/index.js",
    "migrate",
    "deploy",
    "--schema",
    "packages/database/prisma/schema.prisma",
  ],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
