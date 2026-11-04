import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, theme = "light") {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    return route.fulfill({
      json:
        path === "auth/me"
          ? {
              id: "owner",
              name: "Review Administrator",
              email: "owner@example.test",
              role: "owner",
            }
          : path === "preferences"
            ? { uiTheme: theme }
            : path === "servers"
              ? [
                  {
                    id: "server",
                    name: "Review server",
                    host: "192.0.2.10",
                    tags: [],
                  },
                ]
              : path === "operations-status"
                ? {
                    readiness: {
                      status: "degraded",
                      checks: { api: true, worker: false },
                    },
                    backup: { configured: true, intervalHours: 24 },
                    fileHistory: {},
                    sso: {},
                  }
                : [],
    });
  });
}

for (const theme of ["light", "dark"]) {
  test(`status badges meet AA contrast in ${theme}`, async ({ page }) => {
    await setup(page, theme);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/settings/operations");
    await expect(page.locator(".badge.green")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    if (process.env.REVIEW_PHASE) {
      await page
        .locator(".operations-page > .card")
        .first()
        .screenshot({
          path: `docs/ui-review/2026-11-04/status-${theme}-${process.env.REVIEW_PHASE}.png`,
          animations: "disabled",
        });
      return;
    }
    const ratios = await page
      .locator(".badge.green, .badge.red")
      .evaluateAll((badges) => {
        const rgb = (s: string) => s.match(/[\d.]+/g)!.map(Number);
        const luminance = (c: number[]) =>
          c
            .slice(0, 3)
            .map((v) => v / 255)
            .map((v) =>
              v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
            )
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        return badges.map((badge) => {
          const style = getComputedStyle(badge);
          const bg = rgb(style.backgroundColor);
          const panel = rgb(
            getComputedStyle(badge.closest(".card")!).backgroundColor,
          );
          const alpha = bg[3] ?? 1;
          const back = luminance(
            bg.map((v, i) => v * alpha + panel[i] * (1 - alpha)),
          );
          const front = luminance(rgb(style.color));
          return (
            (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)
          );
        });
      });
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    const button = page.getByRole("button", { name: "Refresh status" });
    await button.focus();
    await expect(button).toBeFocused();
    await expect(button).toBeInViewport();
  });
}

test("SFTP ignores superseded directory responses", async ({ page }) => {
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
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sftp/server/list**", async (route) => {
    const path =
      new URL(route.request().url()).searchParams.get("path") || "/srv";
    if (path === "/slow") await pending;
    await route
      .fulfill({
        json: {
          path,
          root: "/srv",
          entries: [
            {
              name: path === "/fast" ? "current.txt" : "old.txt",
              directory: false,
              size: 12,
              mode: 420,
              modifiedAt: 0,
            },
          ],
        },
      })
      .catch(() => {});
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Path", exact: true });
  await expect(input).toHaveValue("/srv");
  await input.fill("/slow");
  const slow = page.waitForRequest("**/list?path=%2Fslow");
  await input.press("Enter");
  await slow;
  await input.fill("/fast");
  await input.press("Enter");
  await expect(page.getByText("current.txt", { exact: true })).toBeVisible();
  release();
  // Drain the delayed response before asserting the visible directory remains current.
  await page.waitForTimeout(300);
  await expect(input).toHaveValue("/fast");
  await expect(page.getByText("current.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("old.txt", { exact: true })).toHaveCount(0);
});

test("leaving Operations aborts its in-flight status request", async ({
  page,
}) => {
  await setup(page);
  await page.route(
    "**/api/operations-status",
    (route) =>
      new Promise<void>((resolve) => {
        page.once("close", () => {
          void route.abort().catch(() => {});
          resolve();
        });
      }),
  );
  await page.goto("/settings/operations");
  await expect(page.getByText("Checking services…")).toBeVisible();
  const aborted = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().endsWith("/api/operations-status"),
    timeout: 3000,
  });
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await aborted;
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
});
