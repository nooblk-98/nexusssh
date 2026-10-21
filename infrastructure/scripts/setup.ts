import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (existsSync(".env")) {
  console.log(".env already exists. Existing secrets preserved.");
  process.exit(0);
}
mkdirSync("data", { recursive: true });
let text = readFileSync(".env.example", "utf8");
for (const name of [
  "ENCRYPTION_KEY",
  "SESSION_SECRET",
  "INTERNAL_SECRET",
  "SETUP_TOKEN",
])
  text = text.replace(
    new RegExp("^" + name + "=$", "m"),
    name + "=" + randomBytes(32).toString("hex"),
  );
text = text.replace(
  "DATABASE_URL=file:./nexusssh.db",
  "DATABASE_URL=file:../../../data/nexusssh.db",
);
writeFileSync(".env", text, { mode: 0o600 });
console.log(
  "Created local .env with generated secrets. Configure SSH_ALLOWED_CIDRS before connecting. Use SETUP_TOKEN from .env to create the first account.",
);
