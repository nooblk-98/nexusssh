import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Drives the workspace against the disposable SSH fixture
// (tests/fixtures/compose.yml). Needs the API to reach 127.0.0.1:22222, so it
// runs against a native `npm run dev` stack with E2E_SSH=1 and the fixture
// network in SSH_ALLOWED_CIDRS; browser.spec.ts must have created the owner.
test.skip(
  process.env.E2E_SSH !== "1",
  "Set E2E_SSH=1 to run against the SSH fixture",
);
test("server, terminal, SFTP, editor and host key prompt", async ({ page }) => {
  const tag = Date.now().toString(36).slice(-5);
  await page.goto("/");
  await page.getByLabel("Email address").fill("browser@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password-12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Quick Connect" }),
  ).toBeVisible();
  const api = async (path: string, body?: unknown) => {
    const r = await page.request.fetch("/api/" + path, {
      method: body ? "POST" : "GET",
      data: body,
      headers: { origin: new URL(page.url()).origin },
    });
    expect(r.ok(), path + " " + (await r.text())).toBeTruthy();
    return r.json();
  };
  const identity = await api("identities", {
    name: "E2E fixture " + tag,
    kind: "password",
    password: "nexus-fixture-only-password",
  });
  const create = async (name: string, fingerprint: string | null) => {
    const group = await api("groups", { name: name + " folder" });
    return api("servers", {
      name,
      host: "127.0.0.1",
      port: 22222,
      username: "nexus",
      identityId: identity.id,
      fingerprint,
      fileRoot: "/home/nexus/files",
      groupId: group.id,
    });
  };
  const { fingerprint } = await api("servers/scan-host-key", {
    host: "127.0.0.1",
    port: 22222,
  });
  await create("E2E " + tag, fingerprint);
  await create("E2E new " + tag, null);
  await page.reload();
  const pane = page.locator(".pane:not(.hidden)");

  // Terminal
  await page
    .locator(".tree-server", { hasText: "E2E " + tag })
    .first()
    .dblclick();
  await expect(pane.locator(".statusbar .state.on")).toBeVisible({
    timeout: 20000,
  });
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'e2e-%s\\n' " + tag + "\n");
  await expect(pane.locator(".xterm-rows")).toContainText("e2e-" + tag);

  // SFTP: upload, open in the editor, save, download
  await pane.getByRole("button", { name: "Open SFTP" }).click();
  await expect(pane.getByRole("cell", { name: "example.txt" })).toBeVisible({
    timeout: 20000,
  });
  await pane.locator("input[type=file]").setInputFiles({
    name: `upload-${tag}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded"),
  });
  await expect(
    pane.getByRole("cell", { name: `upload-${tag}.txt` }),
  ).toBeVisible();
  await pane.getByRole("cell", { name: `upload-${tag}.txt` }).dblclick();
  await expect(page.locator(".pane:not(.hidden) .monaco-editor")).toBeVisible({
    timeout: 30000,
  });
  await page.locator(".pane:not(.hidden) .monaco-editor textarea").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" and edited");
  await page.keyboard.press("Control+s");
  await expect(page.getByText(`Saved upload-${tag}.txt`)).toBeVisible();
  const saved = await api(
    `sftp/${(await api("servers")).find((s: { name: string }) => s.name === "E2E " + tag).id}/read?path=/home/nexus/files/upload-${tag}.txt`,
  );
  expect(saved.content).toBe("uploaded and edited");
  await page
    .locator(".tab", { hasText: "E2E " + tag })
    .nth(1)
    .click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    pane
      .getByRole("row", { name: new RegExp(`upload-${tag}`) })
      .getByRole("button", { name: "Download" })
      .click(),
  ]);
  expect(readFileSync(await download.path()).toString()).toBe(
    "uploaded and edited",
  );
  await pane
    .getByRole("cell", { name: `upload-${tag}.txt` })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(
    pane.getByRole("cell", { name: `upload-${tag}.txt` }),
  ).toHaveCount(0);

  // A server without a pinned key asks before connecting.
  await page.getByRole("tab", { name: "Home" }).click();
  await page.locator(".tree-server", { hasText: "E2E new " + tag }).dblclick();
  await expect(pane.getByText("Unknown host key")).toBeVisible({
    timeout: 20000,
  });
  await expect(
    pane.locator(".fingerprint .mono", { hasText: fingerprint }),
  ).toBeVisible();
  await pane.getByRole("button", { name: "Trust and Connect" }).click();
  await expect(pane.locator(".statusbar .state.on")).toBeVisible({
    timeout: 20000,
  });
});
