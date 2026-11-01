import { test, expect } from "@playwright/test";
import {
  kubernetesOperations,
  kubernetesReadOperations,
} from "../../packages/kubernetes/policy";
const clusterId = "208c4b2a-6f69-439a-83f2-ed43ea8947f2";

test("Administrator defaults to all permissions and Custom exposes selectable grants", async ({
  page,
}) => {
  const serverId = "126618dd-b6ed-416c-96c5-2d36f8469e41";
  let agent: any = null;
  const writes: any[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5),
      method = route.request().method();
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "servers")
      data = [
        {
          id: serverId,
          name: "Example server",
          host: "10.0.0.2",
          port: 22,
          username: "test",
          tags: [],
          status: "unknown",
        },
      ];
    else if (path === "kubernetes/clusters")
      data = [{ id: clusterId, name: "Example cluster" }];
    else if (path === "settings")
      data = {
        operations: ["system_info", "ssh_execute"],
        kubernetesOperations,
      };
    else if (path === "agents" && method === "GET") data = agent ? [agent] : [];
    else if (path === "agents" && method === "POST") {
      const body = route.request().postDataJSON();
      writes.push(body);
      agent = {
        id: "full-admin",
        name: body.name,
        level: body.level,
        permissions: [],
        clusterPermissions: [],
        tokens: [
          {
            revoked: false,
            scopes: JSON.stringify([
              "system_info",
              "ssh_execute",
              ...kubernetesOperations,
              "workspace_manage",
              "workspace_admin",
            ]),
          },
        ],
      };
      data = { agent, token: "fixture-token" };
    } else if (path === "agents/full-admin/access") {
      writes.push(route.request().postDataJSON());
      data = { updated: true };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/agents");
  await page
    .getByRole("button", { name: "Register Agent", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Register Agent",
    exact: true,
  });
  await expect(drawer.getByLabel("Permission level")).toHaveValue(
    "administrator",
  );
  await expect(drawer.getByRole("option")).toHaveText([
    "Administrator",
    "Custom",
  ]);
  await expect(
    drawer.getByText("All MCP permissions enabled", { exact: true }),
  ).toBeVisible();
  await expect(drawer.getByRole("checkbox")).toHaveCount(0);
  await drawer.getByLabel("Agent Name").fill("Full Admin");
  await drawer.getByRole("button", { name: "Create Token" }).click();
  expect(writes[0]).toMatchObject({
    level: "administrator",
    name: "Full Admin",
  });
  for (const key of [
    "serverIds",
    "operations",
    "clusterIds",
    "clusterOperations",
    "workspaceManagement",
  ])
    expect(writes[0]).not.toHaveProperty(key);
  await expect(
    page
      .getByRole("cell")
      .filter({ hasText: "Administrator · All servers and clusters" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Agent Access · Full Admin" });
  await expect(edit.getByRole("checkbox")).toHaveCount(0);
  await edit.getByLabel("Permission level").selectOption("custom");
  await edit
    .getByRole("checkbox", {
      name: "Manage this workspace through MCP",
      exact: true,
    })
    .uncheck();
  await edit
    .getByRole("checkbox", { name: "Example server", exact: true })
    .check();
  await edit
    .getByRole("checkbox", { name: "ssh_execute", exact: true })
    .uncheck();
  await edit.getByRole("button", { name: "Save Access", exact: true }).click();
  expect(writes[1]).toMatchObject({
    level: "custom",
    serverIds: [serverId],
    operations: ["system_info"],
    workspaceManagement: false,
  });
});
test("assign direct cluster tools to an agent without SSH grants and edit its access", async ({
  page,
}) => {
  let agent: any = null;
  const writes: any[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5),
      method = route.request().method();
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "settings")
      data = {
        operations: ["system_info", "ssh_execute"],
        readOperations: ["system_info"],
        kubernetesOperations,
        kubernetesReadOperations,
      };
    else if (path === "kubernetes/clusters")
      data = [{ id: clusterId, name: "Production cluster" }];
    else if (path === "agents" && method === "GET") data = agent ? [agent] : [];
    else if (path === "agents" && method === "POST") {
      const body = route.request().postDataJSON();
      writes.push(body);
      agent = {
        id: "agent-fixture",
        name: body.name,
        level: body.level,
        permissions: [],
        clusterPermissions: body.clusterIds.map((id: string) => ({
          clusterId: id,
          operations: JSON.stringify(body.clusterOperations),
        })),
        tokens: [
          { revoked: false, scopes: JSON.stringify(body.clusterOperations) },
        ],
      };
      data = { agent, token: "fixture-token" };
    } else if (path === "agents/agent-fixture/access") {
      const body = route.request().postDataJSON();
      writes.push(body);
      agent.tokens[0].scopes = JSON.stringify(body.clusterOperations);
      data = { updated: true };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/agents");
  await page
    .getByRole("button", { name: "Register Agent", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Register Agent",
    exact: true,
  });
  await drawer.getByLabel("Agent Name").fill("Kubernetes assistant");
  await expect(
    drawer.getByRole("checkbox", { name: "kubernetes_pod_exec", exact: true }),
  ).toHaveCount(0);
  await expect(drawer.getByLabel("Permission level")).toHaveValue(
    "administrator",
  );
  await expect(drawer.getByRole("option")).toHaveText([
    "Administrator",
    "Custom",
  ]);
  await drawer.getByLabel("Permission level").selectOption("custom");
  await drawer
    .getByRole("checkbox", { name: "Production cluster", exact: true })
    .check();
  for (const op of [
    "kubernetes_clusters_list",
    "kubernetes_execute",
    "kubernetes_pod_exec",
    "kubernetes_execution_status",
  ])
    await drawer.getByRole("checkbox", { name: op, exact: true }).check();
  await drawer.getByRole("button", { name: "Create Token" }).click();
  await expect(
    page.getByText("1 Kubernetes cluster", { exact: true }),
  ).toBeVisible();
  expect(writes[0]).toMatchObject({
    name: "Kubernetes assistant",
    level: "custom",
    serverIds: [],
    operations: [],
    clusterIds: [clusterId],
    clusterOperations: [
      "kubernetes_clusters_list",
      "kubernetes_execute",
      "kubernetes_pod_exec",
      "kubernetes_execution_status",
    ],
  });
  await page.getByRole("button", { name: "Access", exact: true }).click();
  const edit = page.getByRole("dialog", {
    name: "Agent Access · Kubernetes assistant",
  });
  await expect(
    edit.getByRole("checkbox", { name: "Production cluster", exact: true }),
  ).toBeChecked();
  await expect(
    edit.getByRole("checkbox", { name: "kubernetes_pod_exec", exact: true }),
  ).toBeChecked();
  await edit
    .getByRole("checkbox", { name: "kubernetes_pod_exec", exact: true })
    .uncheck();
  await edit.getByRole("button", { name: "Save Access" }).click();
  expect(writes[1].clusterOperations).not.toContain("kubernetes_pod_exec");
  expect(writes[1].clusterIds).toEqual([clusterId]);
});
test("review the exact cluster command and resume through its requesting agent", async ({
  page,
}) => {
  let status = "pending";
  const command = ["sh", "-lc", "printf hello; id"];
  let decisions = 0,
    executions = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "approvals")
      data = [
        {
          id: "approval-fixture",
          operation: "kubernetes_pod_exec",
          clusterId,
          cluster: { name: "Production cluster" },
          args: {
            clusterId,
            namespace: "apps",
            pod: "api-1",
            container: "api",
            command,
            timeoutMs: 30000,
          },
          status,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      ];
    else if (path === "approvals/approval-fixture") {
      expect(route.request().postDataJSON()).toEqual({ decision: "approved" });
      decisions++;
      status = "approved";
      data = { status };
    } else if (path.startsWith("operations/")) executions++;
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/approvals");
  await expect(
    page.getByRole("cell", { name: "Production cluster", exact: true }),
  ).toBeVisible();
  await page.getByText("Review command and arguments", { exact: true }).click();
  const args = page.locator("details pre");
  await expect(args).toContainText("printf hello; id");
  await expect(args).toContainText('"container": "api"');
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByText("Requester can resume with this approval."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Execute", exact: true }),
  ).toHaveCount(0);
  expect(decisions).toBe(1);
  expect(executions).toBe(0);
});
