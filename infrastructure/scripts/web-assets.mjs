import { cpSync, mkdirSync } from "node:fs";
mkdirSync("apps/web/public/monaco", { recursive: true });
cpSync("node_modules/monaco-editor/min/vs", "apps/web/public/monaco/vs", {
  recursive: true,
});
