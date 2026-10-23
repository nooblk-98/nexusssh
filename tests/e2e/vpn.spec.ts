import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
test("import, select, edit and delete a WireGuard VPN profile", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("browser@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password-12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Quick Connect" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "VPN", exact: true }).click();
  await page.getByRole("button", { name: "Add VPN Profile" }).click();
  const name = "VPN browser verification " + Date.now();
  const key = randomBytes(32).toString("base64");
  const conf = `[Interface]\nPrivateKey = ${key}\nAddress = 10.77.0.2/32\nListenPort = 51820\n[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example.test:51820\nAllowedIPs = 10.77.0.0/24`;
  await page.getByLabel(/^Profile name/).fill(name);
  await page
    .getByLabel(/^WireGuard configuration/)
    .fill(conf.replace("Address =", "PostUp = unsupported\nAddress ="));
  await page.getByRole("button", { name: "Save VPN Profile" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Unsupported WireGuard field",
  );
  await page
    .getByLabel("Import WireGuard configuration", { exact: false })
    .setInputFiles({
      name: "office.conf",
      mimeType: "text/plain",
      buffer: Buffer.from(conf),
    });
  await expect(page.getByLabel(/^WireGuard configuration/)).toHaveValue(conf);
  await page.screenshot({
    path: "test-results/vpn-import-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const upload = page.getByLabel("Import WireGuard configuration", {
    exact: false,
  });
  const uploadBox = await upload.boundingBox();
  expect(uploadBox?.height).toBe(35);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/vpn-import-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Save VPN Profile" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("10.77.0.2/32");
  await page.screenshot({
    path: "test-results/vpn-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Server", exact: true }).click();
  await page.getByRole("button", { name: "Advanced Settings" }).click();
  await page.getByLabel(/^VPN profile/).selectOption({ label: name });
  await expect(page.getByLabel(/^Jump host/)).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.getByRole("button", { name: "Advanced Settings" }).click();
  await expect(
    page.getByLabel(/^VPN profile/).locator("option:checked"),
  ).toHaveText(name);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "VPN", exact: true }).click();
  await page.getByRole("button", { name: "Edit " + name, exact: true }).click();
  await expect(page.getByLabel(/^WireGuard configuration/)).toHaveValue("");
  await page
    .getByLabel(/^Description/)
    .fill("Updated without revealing the stored keys");
  await page.getByRole("button", { name: "Save VPN Profile" }).click();
  await expect(row).toContainText("Updated without revealing");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/vpn-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("button", { name: "Delete " + name, exact: true })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
});
