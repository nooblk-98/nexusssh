import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: process.env.E2E_URL || "http://localhost:8080",
    // Edge locally; Playwright's Chromium in CI (PW_CHANNEL overrides).
    channel: process.env.PW_CHANNEL ?? (process.env.CI ? undefined : "msedge"),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: "list",
});
