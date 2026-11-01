import { test, expect } from "@playwright/test";
test("save, retain and clear a Kubernetes profile's WireGuard and SSH bastion selections without reuploading credentials", async ({
  page,
}) => {
  const vpnId = "ad8de694-e8e0-40be-ac04-92d8cb1d42f7",
    bastionId = "fd50ef14-ed2c-452d-a0a1-a418b78fe65a";
  let profile = {
    id: "f13b65a1-742b-4858-a6b6-a2b65b2f875a",
    name: "Private cluster",
    description: "",
    context: "apps",
    namespace: "apps",
    server: "https://cluster.internal.test",
    authentication: "token",
    status: "unknown",
    vpnProfileId: null as string | null,
    bastionId: null as string | null,
  };
  const writes: any[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "kubernetes/clusters") data = [profile];
    else if (path === "vpn-profiles")
      data = [{ id: vpnId, name: "Private network" }];
    else if (path === "servers")
      data = [
        {
          id: bastionId,
          name: "Jump host",
          host: "10.0.0.4",
          port: 22,
          username: "jump",
          bastionId: null,
          fingerprint: "SHA256:fixture",
          tags: [],
          status: "unknown",
          environment: "development",
          icon: "linux",
        },
      ];
    else if (
      path === `kubernetes/clusters/${profile.id}` &&
      route.request().method() === "PATCH"
    ) {
      const body = route.request().postDataJSON();
      writes.push(body);
      profile = { ...profile, ...body };
      data = profile;
    } else if (path.includes("/resources/"))
      data = { items: [], nextCursor: null };
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/kubernetes");
  await page
    .getByRole("button", { name: "Edit Private cluster", exact: true })
    .click();
  let drawer = page.getByRole("dialog", {
    name: "Edit Kubernetes cluster",
    exact: true,
  });
  await drawer.getByLabel("WireGuard VPN").selectOption(vpnId);
  await drawer.getByLabel("SSH bastion").selectOption(bastionId);
  await drawer
    .getByRole("button", { name: "Save cluster", exact: true })
    .click();
  await expect(drawer).toBeHidden();
  expect(writes[0]).toMatchObject({ vpnProfileId: vpnId, bastionId });
  expect(writes[0]).not.toHaveProperty("kubeconfig");
  await page
    .getByRole("button", { name: "Edit Private cluster", exact: true })
    .click();
  drawer = page.getByRole("dialog", {
    name: "Edit Kubernetes cluster",
    exact: true,
  });
  await expect(drawer.getByLabel("WireGuard VPN")).toHaveValue(vpnId);
  await expect(drawer.getByLabel("SSH bastion")).toHaveValue(bastionId);
  await drawer.getByLabel("WireGuard VPN").selectOption("");
  await drawer.getByLabel("SSH bastion").selectOption("");
  await drawer
    .getByRole("button", { name: "Save cluster", exact: true })
    .click();
  await expect(drawer).toBeHidden();
  expect(writes[1]).toMatchObject({ vpnProfileId: null, bastionId: null });
  expect(writes[1]).not.toHaveProperty("kubeconfig");
});

test("a cluster routing failure shows its cause without claiming namespace permissions were denied", async ({
  page,
}) => {
  const failure =
    "Kubernetes API DNS lookup through WireGuard failed. Check the profile's DNS servers and their reachability through the VPN.";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    if (path.includes("/resources/"))
      return route.fulfill({ status: 502, json: { message: failure } });
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "kubernetes/clusters")
      data = [
        {
          id: "f13b65a1-742b-4858-a6b6-a2b65b2f875a",
          name: "Private cluster",
          description: "",
          context: "apps",
          namespace: "apps",
          server: "https://cluster.internal.test",
          authentication: "token",
          status: "unknown",
          vpnProfileId: "ad8de694-e8e0-40be-ac04-92d8cb1d42f7",
          bastionId: null,
        },
      ];
    await route.fulfill({ json: data });
  });
  await page.goto("/settings/kubernetes");
  await page.getByRole("button", { name: "Open cluster", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: failure })).toBeVisible();
  await expect(
    page.getByText(
      "Namespace discovery is unavailable until the cluster connection succeeds.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Namespace discovery is unavailable for this identity.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Namespace", { exact: true }),
  ).toBeEnabled();
});
