import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
const env = parse(readFileSync(".env"));
test("first-run setup, login, workspace, settings and responsive layout", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /^(Create workspace|Sign in)$/ }),
  ).toBeEnabled();
  const setup = page.getByRole("heading", { name: "Create your workspace" });
  if (await setup.isVisible()) {
    await page.getByLabel("Workspace name").fill("Browser verification");
    await page.getByLabel("Your name").fill("Test Owner");
    await page.getByLabel("Installation setup token").fill(env.SETUP_TOKEN);
    await page.getByLabel("Email address").fill("browser@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("browser-test-password-12345");
    await page.getByRole("button", { name: "Create workspace" }).click();
  } else {
    await page.getByLabel("Email address").fill("browser@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("browser-test-password-12345");
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Quick Connect" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent Connections", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Server", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New Server" })).toBeVisible();
  await page.getByRole("button", { name: "Advanced Settings" }).click();
  await expect(
    page.getByRole("dialog", { name: "Advanced Settings" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "MCP Server" }).click();
  await expect(page.getByRole("heading", { name: "MCP Server" })).toBeVisible();
  await page.getByRole("button", { name: "AI Agents" }).click();
  await expect(
    page.getByRole("heading", { name: "No Agents Registered" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Account" }).click();
  await expect(
    page.getByRole("heading", { name: "Two-Factor Authentication" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Quick Connect" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
});
