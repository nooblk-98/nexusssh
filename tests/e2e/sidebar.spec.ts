import { test, expect, type Locator, type Page } from "@playwright/test";

const serverName = "sludi-dev-integration-app-1";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    const data =
      path === "auth/me"
        ? { id: "sidebar-owner", name: "Test Owner", role: "owner" }
        : path === "preferences"
          ? { uiTheme: "light" }
          : path === "servers"
            ? [
                {
                  id: "long-name",
                  name: serverName,
                  host: "192.168.3.20",
                  port: 22,
                  icon: "linux",
                  groupId: "dev",
                  tags: [],
                },
              ]
            : path === "groups"
              ? [
                  { id: "sludi", name: "SLUDI", parentId: null },
                  { id: "dev", name: "DEV", parentId: "sludi" },
                ]
              : [];
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  await expect(page.locator(".tree-server")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
});

const width = (sidebar: Locator) =>
  sidebar.evaluate((el) => el.getBoundingClientRect().width);
async function dragDivider(page: Page, divider: Locator, delta: number) {
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  await page.mouse.up();
}

test("dragging reveals long single-line names and remembers the sidebar width", async ({
  page,
}) => {
  const sidebar = page.locator(".sidebar");
  const divider = page.getByRole("separator", { name: "Resize server list" });
  const name = sidebar.locator(".srv-name");
  const rowHeight = await page
    .locator(".tree-server")
    .evaluate((el) => el.getBoundingClientRect().height);
  await expect.poll(() => width(sidebar)).toBe(305);
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await expect(page.locator(".tree-server")).toHaveAttribute(
    "title",
    `${serverName}\n192.168.3.20`,
  );

  await dragDivider(page, divider, 345);
  await expect.poll(() => width(sidebar)).toBe(650);
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await page
      .locator(".tree-server")
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(rowHeight);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).cursor,
    ),
  ).not.toBe("col-resize");
  await page.reload();
  await expect.poll(() => width(sidebar)).toBe(650);

  await page.getByRole("button", { name: "Hide server list" }).click();
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Show server list" }).click();
  await expect.poll(() => width(sidebar)).toBe(650);
  await divider.dblclick();
  await expect.poll(() => width(sidebar)).toBe(305);
  await page.reload();
  await expect.poll(() => width(sidebar)).toBe(305);
});

test("sidebar resizing supports keys, bounds, and the mobile overlay", async ({
  page,
}) => {
  const sidebar = page.locator(".sidebar");
  const divider = page.getByRole("separator", { name: "Resize server list" });
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => width(sidebar)).toBe(321);
  await page.keyboard.press("End");
  await expect.poll(() => width(sidebar)).toBe(720);
  await dragDivider(page, divider, 400);
  await expect.poll(() => width(sidebar)).toBe(720);
  await dragDivider(page, divider, -1000);
  await expect.poll(() => width(sidebar)).toBe(305);
  await divider.focus();
  await page.keyboard.press("End");
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(() => width(sidebar)).toBe(540);
  expect(await width(page.locator(".main"))).toBeGreaterThanOrEqual(360);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show server list" }).click();
  await expect(sidebar).toBeVisible();
  await expect(divider).toBeHidden();
  await expect.poll(() => width(sidebar)).toBe(305);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(divider).toBeVisible();
  await divider.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => width(sidebar)).toBe(305);
});
