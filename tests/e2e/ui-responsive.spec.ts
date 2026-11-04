import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, theme = "light") {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    return route.fulfill({
      json:
        path === "auth/me"
          ? {
              id: "owner",
              name: "Infrastructure Administrator",
              email: "owner@example.test",
              role: "owner",
            }
          : path === "preferences"
            ? { uiTheme: theme }
            : path === "servers"
              ? [
                  {
                    id: "server",
                    name: "production-observability-primary-server",
                    host: "192.168.1.20",
                    port: 22,
                    username: "administrator",
                    tags: [],
                  },
                ]
              : path === "operations-status"
                ? {
                    readiness: { status: "ready", checks: { api: true } },
                    backup: {},
                    fileHistory: {},
                    sso: {},
                  }
                : path === "settings"
                  ? { operations: [], kubernetesOperations: [] }
                  : [],
    });
  });
}

for (const theme of ["light", "dark"]) {
  test(`workspace and settings fit common viewport widths in ${theme} mode`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page, theme);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const slug of [
        "",
        "account",
        "preferences",
        "identities",
        "operations",
        "runbooks",
        "kubernetes",
        "vpn",
        "users",
        "teams",
        "active-sessions",
        "history",
        "security",
        "mcp",
        "agents",
        "audit",
        "about",
      ]) {
        await page.goto(slug ? `/settings/${slug}` : "/");
        const main = page.locator(slug ? ".settings-main" : ".home-card");
        await expect(main).toBeVisible();
        await expect(main.getByRole("heading").first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(errors).toEqual([]);
        expect(
          await main.evaluate((el) => el.scrollWidth - el.clientWidth),
          `${slug || "home"} at ${width}px`,
        ).toBeLessThanOrEqual(1);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - innerWidth,
          ),
        ).toBeLessThanOrEqual(1);
      }
    }
  });
}

test("mobile settings navigation retains accessible names", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Preferences", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect(page.locator(".home-card")).toBeVisible();
});

test("mobile quick connect and palette keep inputs, names and actions usable", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Connection address" });
  await expect(input).toBeVisible();
  expect((await input.boundingBox())!.width).toBeGreaterThan(180);
  await page.getByRole("button", { name: "Show server list" }).click();
  await page.getByRole("button", { name: "Open command palette" }).click();
  const drawer = page.getByRole("dialog", { name: "Command palette" });
  await expect(drawer).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const name = drawer.locator(".palette-server-name");
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  for (const action of ["Connect", "Details", "Test"])
    await expect(
      drawer.getByRole("button", { name: action, exact: true }),
    ).toBeInViewport();
  const first = drawer.getByRole("button", { name: "Close", exact: true });
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    drawer.getByRole("button", { name: "Test", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open command palette" }),
  ).toBeFocused();
});

test("menus support keyboard navigation and stay within viewport edges", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Layout", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("nested dialogs trap focus and Escape closes only the top overlay", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/workspace-presets", (route) =>
    route.fulfill({
      json: [
        { id: "preset", name: "Production", layout: { columns: 1, tabs: [] } },
      ],
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Workspace presets", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Workspace presets",
    exact: true,
  });
  await drawer.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete preset",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Delete", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Delete", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(
    "hidden",
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Workspace presets", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
    "hidden",
  );
});

test("SFTP path entry and navigation controls fit a phone", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "nexus-workspace",
      JSON.stringify({
        tabs: [
          {
            id: "files",
            kind: "sftp",
            serverId: "server",
            title: "Files",
            path: "/srv",
            status: "connected",
          },
        ],
        active: "files",
        columns: 1,
      }),
    ),
  );
  await page.route("**/api/sftp/server/list**", (route) =>
    route.fulfill({ json: { entries: [], root: "/srv", path: "/srv" } }),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const path = page.getByRole("textbox", { name: "Path", exact: true });
  await expect(path).toBeVisible();
  expect((await path.boundingBox())!.width).toBeGreaterThan(270);
  for (const label of ["Go back", "Go forward", "Find", "Home", "Refresh"])
    await expect(
      page
        .locator(".sftp-nav")
        .getByRole("button", { name: label, exact: true }),
    ).toBeInViewport();
});

test("sign-in fits phone and desktop without horizontal scrolling", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, json: { message: "Sign in required" } }),
  );
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setupRequired: false } }),
  );
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Email address" }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
});
