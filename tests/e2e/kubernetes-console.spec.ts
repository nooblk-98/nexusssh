import { test, expect } from "@playwright/test";
const cluster = {
  id: "de04aa8a-7688-4204-bcd1-5666e9166859",
  name: "Development cluster",
  context: "development",
  namespace: "apps",
  server: "https://cluster.internal.test",
  status: "unknown",
  authentication: "token",
};

test("opens a cluster console in a workspace tab, runs commands, edits history and applies an inline manifest", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  const commands: any[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "kubernetes/clusters") data = [cluster];
    else if (path.endsWith("/check"))
      data = { ...cluster, status: "connected", version: "v1.28.9+rke2r1" };
    else if (path.endsWith("/console")) {
      const body = route.request().postDataJSON();
      commands.push(body);
      data = {
        output: body.command.includes("apply")
          ? "configmap/settings configured\n"
          : "NAME       STATUS\nworker-1   Ready\n",
        truncated: false,
      };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/kubernetes");
  await expect(page.getByLabel("Resource", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open console", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("tab", { name: /Development cluster/ }),
  ).toBeVisible();
  const consolePane = page.getByLabel(
    "Kubernetes console Development cluster",
    { exact: true },
  );
  const output = consolePane.locator(".xterm-rows");
  const input = consolePane.locator(".xterm-helper-textarea");
  await expect(output).toContainText("Connected · v1.28.9+rke2r1");
  await input.focus();
  await page.keyboard.insertText("kubectl get nodes");
  await page.keyboard.press("Enter");
  await expect(output).toContainText("worker-1");
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    command: ["kubectl", "get", "nodes"],
    namespace: "apps",
  });
  await expect(consolePane.getByLabel("Console namespace")).toHaveCount(0);
  await input.focus();
  await page.keyboard.insertText(
    "kubectl config set-context --current --namespace=production",
  );
  await page.keyboard.press("Enter");
  await expect(output).toContainText("Namespace set to production.");
  expect(commands).toHaveLength(1);
  await input.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toMatchObject({
    command: ["kubectl", "get", "nodes"],
    namespace: "production",
  });
  await expect(consolePane.getByRole("status")).toHaveText("Ready");
  await input.focus();
  await page.keyboard.insertText("kubectl apply -f -");
  await page.keyboard.press("Enter");
  await expect(output).toContainText("Paste one YAML/JSON manifest");
  const manifest =
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\ndata:\n  message: hello\n";
  await input.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, manifest);
  await page.keyboard.press("Control+d");
  await expect.poll(() => commands.length).toBe(3);
  expect(commands[2]).toMatchObject({
    command: ["kubectl", "apply", "-f", "-"],
    namespace: "production",
    manifest,
  });
  await expect(output).toContainText("configmap/settings configured");
  await page.reload();
  await expect(consolePane.getByLabel("Console namespace")).toHaveCount(0);
  await expect(output).toContainText("kubectl (production) >");
  await expect(output).toContainText("Connected");
  await page.screenshot({
    path: "test-results/kubernetes-console.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close Development cluster", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Open console Development cluster",
      exact: true,
    })
    .click();
  await expect(output).toContainText("Connected");
  await expect(output).toContainText("kubectl (apps) >");
  expect(errors).toEqual([]);
});

test("shows command errors and supports cancel without automatically retrying commands", async ({
  page,
}) => {
  let writes = 0,
    release: (() => void) | undefined;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = {};
    else if (path === "kubernetes/clusters") data = [cluster];
    else if (path.endsWith("/check")) data = { ...cluster, version: "v1.28.9" };
    else if (path.endsWith("/console")) {
      writes++;
      if (writes === 1)
        return route.fulfill({
          status: 403,
          json: {
            message:
              "The kubeconfig identity does not have permission for this Kubernetes resource.",
          },
        });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return route
        .fulfill({ json: { output: "late response", truncated: false } })
        .catch(() => {});
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Open console Development cluster",
      exact: true,
    })
    .click();
  const pane = page.getByLabel("Kubernetes console Development cluster", {
    exact: true,
  });
  const input = pane.locator(".xterm-helper-textarea");
  const output = pane.locator(".xterm-rows");
  await expect(output).toContainText("Connected");
  await input.focus();
  await page.keyboard.insertText("kubectl get pods");
  await page.keyboard.press("Enter");
  await expect(output).toContainText("does not have permission");
  await input.focus();
  await page.keyboard.insertText("kubectl scale deploy/api --replicas=2");
  await page.keyboard.press("Enter");
  await expect.poll(() => writes).toBe(2);
  await pane
    .getByRole("button", { name: "Cancel command", exact: true })
    .click();
  await expect(output).toContainText("remote outcome may be unknown");
  release?.();
  await expect(
    pane.getByRole("button", { name: "Cancel command", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(2);
});
