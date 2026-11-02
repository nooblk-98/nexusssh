import { test, expect, type Page } from "@playwright/test";
const server = {
  id: "2cc27c83-600d-4b40-b6bf-e94334f18ec1",
  name: "Application",
  host: "10.0.0.5",
  port: 22,
  username: "app",
  icon: "linux",
  groupId: null,
  tags: [],
  environment: "development",
};
async function setup(page: Page, editor = false) {
  await page.addInitScript(
    ({ server, editor }) => {
      sessionStorage.setItem(
        "nexus-workspace",
        JSON.stringify({
          tabs: [
            {
              id: "initial-tab",
              kind: editor ? "editor" : "terminal",
              serverId: server.id,
              title: editor ? "app.conf" : server.name,
              ...(editor
                ? { path: "/safe/app.conf" }
                : { resume: "must-not-be-in-preset" }),
            },
          ],
          active: "initial-tab",
          columns: 1,
        }),
      );
    },
    { server, editor },
  );
  await page.routeWebSocket("**/ws/terminal?*", (socket) =>
    socket.send(
      JSON.stringify({
        type: "ready",
        resume: "private-resume-token",
        sessionId: "fixture-session",
      }),
    ),
  );
}
test("protects unsaved editor changes and requires acknowledgement of remote conflicts", async ({
  page,
}) => {
  await setup(page, true);
  let conflict = false;
  const writes: any[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", role: "owner", name: "Owner" };
    if (path === "preferences") data = { uiTheme: "light" };
    if (path === "servers") data = [server];
    if (path.endsWith("/read"))
      data = {
        content: conflict ? "changed remotely" : "original",
        version: conflict ? "b".repeat(64) : "a".repeat(64),
        historyEnabled: false,
      };
    if (path.endsWith("/write")) {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) {
        conflict = true;
        return route.fulfill({
          status: 409,
          json: { message: "The remote file changed since you opened it." },
        });
      }
      data = { version: "c".repeat(64) };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  const input = page.locator(".monaco-editor textarea.inputarea").first();
  await expect(input).toBeAttached();
  await input.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("my edited configuration");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await page
    .getByRole("button", { name: "Close app.conf", exact: true })
    .click();
  const guard = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("tab", { name: /app.conf/ })).toBeVisible();
  await save.click();
  await expect(page.locator(".alert.danger")).toContainText(
    "remote file changed",
  );
  await page.getByRole("button", { name: "Compare with remote" }).click();
  await page
    .getByRole("button", { name: "Use remote as save baseline" })
    .click();
  await save.click();
  await expect(save).toBeDisabled();
  expect(writes[0].expectedVersion).toBe("a".repeat(64));
  expect(writes[1].expectedVersion).toBe("b".repeat(64));
  await page
    .getByRole("button", { name: "Close app.conf", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /app.conf/ })).toHaveCount(0);
});
test("saves account workspace presets without terminal resume tokens and opens them", async ({
  page,
}) => {
  await setup(page);
  const presets: any[] = [];
  let payload: any;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", role: "owner", name: "Owner" };
    if (path === "servers") data = [server];
    if (path === "workspace-presets") {
      if (route.request().method() === "POST") {
        payload = route.request().postDataJSON();
        presets.push({ id: "preset", ...payload });
        data = { id: "preset" };
      } else data = presets;
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Workspace presets", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Workspace presets" });
  await drawer.getByLabel("Save current layout as").fill("On call");
  await drawer
    .getByRole("button", { name: "Save preset", exact: true })
    .click();
  await expect(drawer.getByText(/On call/)).toBeVisible();
  expect(JSON.stringify(payload)).not.toContain("resume");
  expect(payload.layout.tabs[0].serverId).toBe(server.id);
  await drawer.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Application/ })).toHaveCount(2);
});
test("shows service readiness and backup verification and starts a configured backup", async ({
  page,
}) => {
  let runs = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", role: "owner", name: "Owner" };
    if (path === "operations-status")
      data = {
        readiness: {
          status: "degraded",
          checks: { database: true, redis: true, worker: false, vpn: true },
        },
        backup: {
          configured: true,
          running: runs > 0,
          intervalHours: 24,
          offHostConfigured: true,
          lastSuccessAt: "2026-11-02T00:00:00Z",
          lastRehearsedAt: "2026-11-02T00:01:00Z",
        },
        sso: { enabled: false },
        fileHistory: { enabled: true, retentionDays: 30 },
      };
    if (path === "operations-status/backup") {
      runs++;
      data = { status: "started" };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/operations");
  await expect(
    page.getByRole("heading", { name: "Service readiness" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "degraded" }),
  ).toHaveText("degraded");
  await page.getByRole("button", { name: "Run backup and verify" }).click();
  await expect(
    page.getByRole("button", { name: "Backing up and verifying…" }),
  ).toBeDisabled();
  expect(runs).toBe(1);
  await page.screenshot({
    path: "test-results/operations-settings.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Encrypted backups" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/operations-settings-mobile.png",
    fullPage: true,
  });
});
test("creates and reloads a runbook version", async ({ page }) => {
  const books: any[] = [];
  let saved: any;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", role: "owner", name: "Owner" };
    if (path === "runbooks") {
      if (route.request().method() === "POST") {
        saved = route.request().postDataJSON();
        books.push({
          id: "book",
          name: saved.name,
          revisions: [{ id: "rev", version: 1 }],
        });
        data = { id: "book", version: 1 };
      } else data = books;
    }
    if (path === "runbooks/book/revisions/rev")
      data = { ...saved.definition, parameters: ["service"], version: 1 };
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/runbooks");
  await page.getByLabel("Runbook name").fill("Check service");
  await page
    .getByLabel("Command template")
    .fill("systemctl status -- {{service}}");
  await page.getByRole("button", { name: "Save new version" }).click();
  await page.getByLabel("Command template").fill("");
  await page.getByRole("button", { name: "Load v1" }).click();
  await expect(page.getByLabel("Command template")).toHaveValue(
    "systemctl status -- {{service}}",
  );
  expect(saved.definition.timeoutMs).toBe(30000);
});
