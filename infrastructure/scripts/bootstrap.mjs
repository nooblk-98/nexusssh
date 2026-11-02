import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("NexusSSH requires Node.js 24 or newer.");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args) {
  const result = spawnSync(npm, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
run(["ci"]);
if (!existsSync(".env")) run(["run", "setup"]);
run(["run", "db:generate"]);
run(["run", "db:migrate"]);
run(["run", "typecheck"]);
console.log("Bootstrap complete. Start Redis, then run npm run dev.");
