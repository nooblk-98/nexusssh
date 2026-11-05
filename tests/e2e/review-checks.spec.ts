import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, theme = "light") {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    return route.fulfill({
      json:
        path === "auth/me"
          ? { id: "owner", name: "Review owner", role: "owner" }
          : path === "preferences"
            ? { uiTheme: theme }
            : path === "kubernetes/clusters"
              ? ["alpha", "beta"].map((id) => ({
                  id,
                  name: id,
                  server: `https://${id}.infrastructure.example.test:6443`,
                  context: "production",
                  namespace: "production",
                  status: "unknown",
                  authentication: "token",
                }))
              : path.includes("/resources/")
                ? { items: [], nextCursor: null }
                : [],
    });
  });
}

for (const theme of ["light", "dark"]) {
  test(`primary actions meet AA contrast in ${theme}`, async ({ page }) => {
    await setup(page, theme);
    await page.setViewportSize({
      width: process.env.REVIEW_PHASE ? 1440 : 390,
      height: 900,
    });
    await page.goto("/settings/kubernetes");
    const button = page.getByRole("button", { name: "Open console" }).first();
    await expect(button).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    if (process.env.REVIEW_PHASE) {
      await page.locator(".kube-page").screenshot({
        path: `docs/ui-review/2026-11-05/primary-${theme}-${process.env.REVIEW_PHASE}.png`,
        animations: "disabled",
      });
      return;
    }
    for (const hovered of [false, true]) {
      if (hovered) {
        await button.hover();
        await page.waitForTimeout(250);
      }
      const ratio = await button.evaluate((el) => {
        const luminance = (value: string) =>
          value
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => v / 255)
            .map((v) =>
              v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
            )
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const style = getComputedStyle(el),
          a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      console.log(
        `${theme} ${hovered ? "hover" : "normal"} contrast: ${ratio.toFixed(2)}`,
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    await button.focus();
    await expect(button).toBeFocused();
    await expect(button).toBeInViewport();
    expect(
      await page
        .locator(".settings-main")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });
}

test("connection checks refresh metadata without reloading resource lists", async ({
  page,
}) => {
  await setup(page);
  let reads = 0;
  page.on("request", (req) => {
    if (req.url().includes("/resources/")) reads++;
  });
  await page.goto("/settings/kubernetes");
  await page
    .getByRole("button", { name: "Browse resources", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh resources", exact: true }),
  ).toBeEnabled();
  await expect.poll(() => reads).toBe(2);
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(
    page.getByText("alpha: Kubernetes API connection verified.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test connection", exact: true }),
  ).toBeEnabled();
  console.log(`Resource reads including initial browse: ${reads}`);
  expect(reads).toBe(2);
});

test("a delayed check error does not replace another cluster's view", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/kubernetes/clusters/alpha/check", async (route) => {
    await pending;
    await route.fulfill({
      status: 502,
      json: { message: "Alpha connection failed" },
    });
  });
  await page.goto("/settings/kubernetes");
  await page
    .getByRole("button", { name: "Browse resources", exact: true })
    .first()
    .click();
  const requested = page.waitForRequest("**/alpha/check");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await requested;
  await page.getByRole("button", { name: "All clusters", exact: true }).click();
  await page
    .getByRole("button", { name: "Browse resources", exact: true })
    .last()
    .click();
  release();
  await expect(
    page.getByText("alpha: Alpha connection failed", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".kube-page [role=alert]")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "beta", exact: true }),
  ).toBeVisible();
});
