import { test, expect, type Page } from "@playwright/test";

const createdAt = "2026-11-04T00:00:00Z";
const user = {
  id: "owner",
  name: "Production Administrator",
  email: "administrator@infrastructure.example.test",
  role: "owner",
  organization: { name: "Production infrastructure workspace" },
};
const server = {
  id: "server",
  name: "production-observability-primary",
  host: "192.168.1.20",
  tags: [],
};
const fixtures: Record<string, unknown> = {
  "auth/me": user,
  users: [user],
  servers: [server],
  teams: [
    {
      id: "team",
      name: "Platform administrators",
      members: [{ userId: user.id, user }],
      servers: [],
    },
  ],
  identities: [
    {
      id: "key",
      name: "Production infrastructure SSH key",
      kind: "key",
      createdAt,
      _count: { servers: 12 },
    },
  ],
  "vpn-profiles": [
    {
      id: "vpn",
      name: "Production network",
      description: "Infrastructure WireGuard connection",
      summary: {
        addresses: ["10.200.49.4/24"],
        peers: [{ endpoint: "vpn.infrastructure.example.test:51820" }],
      },
      _count: { servers: 12, clusters: 4 },
    },
  ],
  sessions: [
    {
      id: "session",
      principalId: user.id,
      server,
      status: "active",
      createdAt,
    },
  ],
  agents: [
    {
      id: "agent",
      name: "Production operations assistant",
      level: "administrator",
      permissions: [],
      tokens: [{ scopes: "[]" }],
    },
  ],
  audit: [
    {
      id: "event",
      action: "ssh_execute",
      principalId: user.id,
      serverId: server.id,
      status: "success",
      createdAt,
      requestId: "b5db53dd-ae9d-4239-8c55-b6aa2f7a1639",
    },
  ],
  settings: {
    endpoint: "https://nexus.infrastructure.example.test/mcp",
    operations: ["ssh_execute", "sftp_read"],
    kubernetesOperations: ["kubernetes_list_resources"],
    workspaceCidrs: ["10.200.0.0/16"],
    deploymentCidrs: ["2001:db8:1234:5678::/64"],
  },
  runbooks: [
    {
      id: "runbook",
      name: "Production service status",
      revisions: Array.from({ length: 5 }, (_, i) => ({
        id: `revision-${i}`,
        version: 10 - i,
        createdAt,
      })),
    },
  ],
};

async function setup(page: Page, theme: "light" | "dark") {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    return route.fulfill({
      json:
        path === "preferences"
          ? { uiTheme: theme, mfaEnabled: true }
          : (fixtures[path] ?? []),
    });
  });
}

async function expectContainedMain(page: Page) {
  const overflow = await page
    .locator(".settings-main")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const theme of ["light", "dark"] as const) {
  test(`settings tables contain scrolling and preserve cell alignment in ${theme} mode`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await setup(page, theme);
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const slug of [
        "identities",
        "vpn",
        "users",
        "teams",
        "active-sessions",
        "history",
        "security",
        "agents",
        "audit",
      ]) {
        await page.goto(`/settings/${slug}`);
        await expect(
          page.locator(".settings-main tbody tr").first(),
        ).toBeVisible();
        await expectContainedMain(page);
        const cells = await page
          .locator(".settings-main td")
          .evaluateAll((elements) =>
            elements.map((element) => ({
              display: getComputedStyle(element).display,
              padding: getComputedStyle(element).paddingTop,
            })),
          );
        expect(
          cells.every(
            (cell) => cell.display === "table-cell" && cell.padding === "12px",
          ),
        ).toBe(true);
        const main = page.locator(".settings-main");
        const wrappers = main.locator(".table-card, .settings-table-scroll");
        expect(await wrappers.count()).toBeGreaterThan(0);
        for (const wrapper of await wrappers.all()) {
          expect(
            await wrapper.evaluate(
              (element) => getComputedStyle(element).overflowX,
            ),
          ).toBe("auto");
        }
      }
    }
  });
}

test("runbook actions wrap and account editing fits a narrow screen", async ({
  page,
}) => {
  await setup(page, "light");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/settings/runbooks");
  const actions = page.locator(".runbook-actions");
  await expect(actions.getByRole("button")).toHaveCount(6);
  await expectContainedMain(page);
  const fits = await actions.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("button")].every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right + 1;
    });
  });
  expect(fits).toBe(true);
  expect(
    (await page.getByLabel("Command template").boundingBox())!.height,
  ).toBeGreaterThan(60);
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Edit display name" }).click();
  await expect(page.locator(".account-name-edit input")).toBeVisible();
  await expectContainedMain(page);
});

test("MCP copy controls leave the command and configuration text unobscured", async ({
  page,
}) => {
  await setup(page, "light");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/settings/mcp");
  await page.getByText("Configure a client manually", { exact: true }).click();
  await expect(page.locator(".mcp-code-block")).toHaveCount(2);
  const clear = await page.locator(".mcp-code-block").evaluateAll((blocks) =>
    blocks.every((block) => {
      const code = block.querySelector("code")!;
      const button = block.querySelector("button")!;
      const range = document.createRange();
      range.setStart(code.firstChild!, 0);
      range.setEnd(code.firstChild!, 1);
      return (
        range.getBoundingClientRect().top >=
        button.getBoundingClientRect().bottom
      );
    }),
  );
  expect(clear).toBe(true);
  await expectContainedMain(page);
});
