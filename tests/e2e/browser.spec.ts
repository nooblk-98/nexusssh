import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
const env = parse(readFileSync(".env"));
test("first-run setup, login, empty dashboard, responsive layout and navigation", async ({
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
    page.getByRole("heading", { name: "Infrastructure overview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your first connection starts here" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Add a server" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "MCP Server", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Remote MCP gateway" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "AI Agents", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No agents registered" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Account security" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Navigation").selectOption("Dashboard");
  await expect(
    page.getByRole("heading", { name: "Infrastructure overview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
});
