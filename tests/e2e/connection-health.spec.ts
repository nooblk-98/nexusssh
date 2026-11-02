import { test, expect } from "@playwright/test";

test("distinguishes unavailable checks from offline hosts and prefers a connected SSH terminal", async ({
  page,
}) => {
  const host = {
    id: "bb7e82c5-5a68-4dba-8efc-f9bacc0bf891",
    name: "VPN bastion",
    host: "192.0.2.5",
    port: 22,
    username: "test",
    icon: "linux",
    groupId: null,
    tags: [],
    status: "unreachable",
    healthFailureCategory: "route",
    lastCheckedAt: new Date().toISOString(),
    fingerprint: "SHA256:fixture",
    environment: "development",
  };
  const servers = [
    host,
    {
      ...host,
      id: "c7a43cd1-f598-42ed-96ee-b141bd7e4065",
      name: "Offline host",
      healthFailureCategory: "network",
    },
    {
      ...host,
      id: "7b6c9f2d-cab6-4d28-a74e-40fb65d46429",
      name: "Healthy host",
      status: "reachable",
      healthFailureCategory: null,
    },
  ];
  let reads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "servers") {
      reads++;
      data = servers;
    }
    await route.fulfill({ json: data });
  });
  await page.routeWebSocket("**/ws/terminal?*", (socket) => {
    socket.send(
      JSON.stringify({
        type: "ready",
        resume: "fixture-resume",
        sessionId: "fixture-session",
      }),
    );
  });
  await page.goto("/");
  const row = (name: string) => page.locator(".tree-server", { hasText: name });
  await expect(
    row("VPN bastion").getByRole("img", {
      name: "Connection unknown",
      exact: true,
    }),
  ).toHaveAttribute("title", /Check unavailable: route/);
  await expect(
    row("Offline host").getByRole("img", {
      name: "Connection unreachable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    row("Healthy host").getByRole("img", {
      name: "Connection reachable",
      exact: true,
    }),
  ).toBeVisible();
  const previousReads = reads;
  await row("VPN bastion").dblclick();
  await expect(
    row("VPN bastion").getByRole("img", {
      name: "Connection reachable",
      exact: true,
    }),
  ).toHaveAttribute("title", "Connected SSH session");
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await page.screenshot({
    path: "test-results/connection-health.png",
    fullPage: true,
  });
});
