import { test, expect } from "@playwright/test";

const clusterId = "fa74d1f0-24bc-4a58-b20a-86eae73d45a6";
const kubeconfig =
  "apiVersion: v1\nkind: Config\ncurrent-context: development\nclusters: []\nusers: []\ncontexts: []\n";
const pod = (name: string) => ({
  uid: name,
  name,
  namespace: "production",
  createdAt: "2026-10-01T00:00:00Z",
  status: "Running",
  ready: "1/1",
  detail: "worker-1",
  restarts: 0,
  containers: [
    { name: "api", image: "app:v1" },
    { name: "sidecar", image: "helper:v1" },
  ],
});

test("import a direct cluster, browse paginated resources, read logs, edit metadata and remove the profile", async ({
  page,
}) => {
  let cluster: any = null;
  let denyResources = false;
  const logQueries: URLSearchParams[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(5);
    const method = route.request().method();
    if (denyResources && path.includes("/resources/"))
      return route.fulfill({
        status: 403,
        json: { message: "Cluster permission was revoked." },
      });
    let data: any = [];
    if (path === "auth/me")
      data = { id: "fixture", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "kubernetes/contexts")
      data = {
        currentContext: "development",
        contexts: [
          {
            name: "development",
            namespace: "apps",
            server: "https://cluster.example.test:6443",
          },
          {
            name: "production",
            namespace: "production",
            server: "https://cluster.example.test:6443",
          },
        ],
      };
    else if (path === "kubernetes/clusters" && method === "GET")
      data = cluster ? [cluster] : [];
    else if (path === "kubernetes/clusters" && method === "POST") {
      const body = route.request().postDataJSON();
      expect(body.context).toBe("production");
      expect(body.kubeconfig).toBe(kubeconfig);
      cluster = {
        id: clusterId,
        name: body.name,
        description: body.description,
        server: "https://cluster.example.test:6443",
        context: "production",
        namespace: "production",
        authentication: "token",
        status: "unknown",
        version: null,
        lastCheckedAt: null,
        lastError: null,
      };
      data = cluster;
    } else if (path === `kubernetes/clusters/${clusterId}/check`) {
      cluster = {
        ...cluster,
        status: "connected",
        version: "v1.34.0",
        lastCheckedAt: new Date().toISOString(),
      };
      data = cluster;
    } else if (
      path === `kubernetes/clusters/${clusterId}` &&
      method === "PATCH"
    ) {
      const body = route.request().postDataJSON();
      expect(body).not.toHaveProperty("kubeconfig");
      cluster = { ...cluster, name: body.name, description: body.description };
      data = cluster;
    } else if (
      path === `kubernetes/clusters/${clusterId}` &&
      method === "DELETE"
    ) {
      cluster = null;
      data = { deleted: true };
    } else if (path.endsWith("/resources/namespaces"))
      data = {
        items: [
          { ...pod("production"), namespace: "", status: "Active" },
          { ...pod("apps"), namespace: "", status: "Active" },
        ],
        nextCursor: null,
      };
    else if (path.endsWith("/resources/pods")) {
      expect(url.searchParams.get("namespace")).toBe("production");
      data = {
        items: [pod(url.searchParams.has("cursor") ? "api-next" : "api-first")],
        nextCursor: url.searchParams.has("cursor")
          ? null
          : "opaque+next&cursor",
      };
      if (url.searchParams.has("cursor"))
        expect(url.searchParams.get("cursor")).toBe("opaque+next&cursor");
    } else if (path.endsWith("/resources/nodes")) {
      expect(url.searchParams.has("namespace")).toBe(false);
      data = {
        items: [
          {
            ...pod("worker-1"),
            namespace: "",
            status: "Ready",
            detail: "v1.34.0 · Linux",
          },
        ],
        nextCursor: null,
      };
    } else if (path.endsWith("/logs")) {
      logQueries.push(url.searchParams);
      data = {
        content:
          "2026-11-01 api started\n<script>untrusted pod output</script>\n",
        truncated: false,
      };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Kubernetes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No Kubernetes clusters" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add cluster", exact: true }).click();
  await page.getByLabel("Cluster name").fill("Production Kubernetes");
  await page.getByLabel("Import kubeconfig", { exact: false }).setInputFiles({
    name: "config",
    mimeType: "application/yaml",
    buffer: Buffer.from(kubeconfig),
  });
  await page.getByLabel("Kubernetes context").selectOption("production");
  await page.getByRole("button", { name: "Save cluster", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "api-first", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.locator(".kube-cluster-heading")).toContainText("v1.34.0");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "api-next", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh resources", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "api-first", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "api-next", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View logs for api-first", exact: true })
    .click();
  const logs = page.getByRole("dialog", { name: "Logs: api-first" });
  await expect(logs.locator("pre")).toContainText(
    "<script>untrusted pod output</script>",
  );
  await logs.getByLabel("Container", { exact: true }).selectOption("sidecar");
  await expect.poll(() => logQueries.at(-1)?.get("container")).toBe("sidecar");
  await logs.getByLabel("Previous container instance").check();
  await expect.poll(() => logQueries.at(-1)?.get("previous")).toBe("true");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await logs.getByRole("button", { name: "Close logs" }).click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("Resource", { exact: true }).selectOption("nodes");
  await expect(
    page.getByRole("cell", { name: "worker-1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit Production Kubernetes", exact: true })
    .click();
  await expect(page.getByLabel("Kubeconfig contents")).toHaveValue("");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Updated without re-entering credentials");
  await page.getByRole("button", { name: "Save cluster", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "api-first", exact: true }),
  ).toBeVisible();
  denyResources = true;
  await page
    .getByRole("button", { name: "Refresh resources", exact: true })
    .click();
  await expect(page.locator(".kube-page").getByRole("alert")).toContainText(
    "permission was revoked",
  );
  await expect(
    page.getByRole("cell", { name: "api-first", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Remove Production Kubernetes", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Remove Kubernetes cluster" })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No Kubernetes clusters" }),
  ).toBeVisible();
});

test("handles unsupported contexts and cluster RBAC failures without showing credentials", async ({
  page,
}) => {
  let created = false;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    const method = route.request().method();
    let data: any = [],
      status = 200;
    if (path === "auth/me") data = { id: "owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "dark" };
    else if (path === "kubernetes/contexts")
      data = {
        currentContext: "cloud",
        contexts: [
          { name: "cloud", error: "Login plugins are not supported." },
        ],
      };
    else if (path === "kubernetes/clusters" && method === "POST") {
      created = true;
      data = {
        id: clusterId,
        name: "Restricted",
        context: "reader",
        namespace: "apps",
        authentication: "token",
        server: "https://api.example.test",
        status: "unknown",
      };
    } else if (path === "kubernetes/clusters")
      data = created
        ? [
            {
              id: clusterId,
              name: "Restricted",
              context: "reader",
              namespace: "apps",
              authentication: "token",
              server: "https://api.example.test",
              status: "unknown",
            },
          ]
        : [];
    else if (path.includes("/resources/")) {
      status = 403;
      data = {
        message:
          "The kubeconfig identity does not have permission for this Kubernetes resource.",
      };
    }
    return route.fulfill({ status, json: data });
  });
  await page.goto("/settings/kubernetes");
  await page.getByRole("button", { name: "Add cluster", exact: true }).click();
  await page.getByLabel("Cluster name").fill("Restricted");
  await page.getByLabel("Kubeconfig contents").fill("unsupported fixture");
  await page
    .getByRole("button", { name: "Read contexts", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Add Kubernetes cluster" })
      .getByRole("alert"),
  ).toContainText("No supported contexts");
  await expect(
    page.getByRole("button", { name: "Save cluster", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Kubeconfig contents").fill(kubeconfig);
  await page.getByRole("button", { name: "Save cluster", exact: true }).click();
  await expect(page.locator(".kube-page").getByRole("alert")).toContainText(
    "does not have permission",
  );
  await expect(page.getByLabel("Namespace", { exact: true })).toBeEnabled();
});

test("regular viewers cannot open Kubernetes administration", async ({
  page,
}) => {
  let clusterCalls = 0;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    if (path.startsWith("kubernetes/")) clusterCalls++;
    return route.fulfill({
      json:
        path === "auth/me"
          ? {
              id: "viewer",
              role: "viewer",
              name: "Viewer",
              email: "viewer@example.test",
            }
          : path === "preferences"
            ? {}
            : [],
    });
  });
  await page.goto("/settings/kubernetes");
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Settings", exact: true })
      .getByRole("button", { name: "Kubernetes", exact: true }),
  ).toHaveCount(0);
  expect(clusterCalls).toBe(0);
});
