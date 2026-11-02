import { test, expect } from "@playwright/test";

test("organize clusters in shared nested folders using drag, move, edit and folder deletion", async ({
  page,
}) => {
  const parentId = "e156da40-a47c-47a6-970e-874b4ff527ed",
    devId = "ab5fb5f2-456d-4c6e-92cb-0cb6242bf402",
    myId = "104c88fc-4112-4bf8-ac4e-784ee9ccdc64";
  let folders = [
    { id: parentId, name: "SLUDI", parentId: null as string | null },
    { id: devId, name: "DEV", parentId },
    { id: myId, name: "MY", parentId: null },
  ];
  let cluster = {
    id: "de04aa8a-7688-4204-bcd1-5666e9166859",
    name: "sludi-mvp-dev-mosip",
    context: "mosip-cluster",
    namespace: "default",
    description: "",
    server: "https://cluster.internal.test",
    status: "unknown",
    authentication: "token",
    vpnProfileId: null,
    bastionId: null,
    groupId: null as string | null,
  };
  const moves: any[] = [],
    edits: any[] = [];
  let deletedClusters = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5),
      method = route.request().method();
    let data: any = [];
    if (path === "auth/me")
      data = { id: "owner", name: "Owner", role: "owner" };
    else if (path === "preferences") data = { uiTheme: "light" };
    else if (path === "groups") data = folders;
    else if (path === "servers")
      data = [
        {
          id: "7f0d68b9-779a-4cc5-a775-4788058040b7",
          name: "Home Server",
          host: "192.168.1.106",
          port: 22,
          username: "test",
          groupId: myId,
          icon: "linux",
          status: "unknown",
          tags: [],
          environment: "development",
        },
      ];
    else if (path === "kubernetes/clusters") data = [cluster];
    else if (path === `kubernetes/clusters/${cluster.id}/move`) {
      const body = route.request().postDataJSON();
      moves.push(body);
      cluster = { ...cluster, groupId: body.groupId };
      data = { id: cluster.id, groupId: cluster.groupId };
    } else if (
      path === `kubernetes/clusters/${cluster.id}` &&
      method === "PATCH"
    ) {
      const body = route.request().postDataJSON();
      edits.push(body);
      cluster = { ...cluster, ...body };
      data = cluster;
    } else if (
      path === `kubernetes/clusters/${cluster.id}` &&
      method === "DELETE"
    ) {
      deletedClusters++;
      data = { deleted: true };
    } else if (path.startsWith("groups/") && method === "DELETE") {
      const id = path.slice(7);
      folders = folders
        .filter((folder) => folder.id !== id)
        .map((folder) => ({
          ...folder,
          parentId: folder.parentId === id ? null : folder.parentId,
        }));
      if (cluster.groupId === id) cluster = { ...cluster, groupId: null };
      data = { deleted: true };
    }
    await route.fulfill({ json: data });
  });
  const folder = (id: string) => page.locator(`[data-folder-id="${id}"]`);
  const folderButton = (id: string) => folder(id).locator(":scope > button");
  const row = () =>
    page.getByRole("button", {
      name: `Open console ${cluster.name}`,
      exact: true,
    });
  await page.goto("/");
  await expect(row()).toBeVisible();
  await row().dragTo(folderButton(devId));
  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toEqual({ groupId: devId });
  await expect(
    folder(devId).getByRole("button", {
      name: `Open console ${cluster.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await folderButton(parentId).click();
  await expect(row()).toBeHidden();
  await page
    .getByRole("textbox", { name: "Search", exact: true })
    .fill("mosip");
  await expect(row()).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search", exact: true })
    .fill("SLUDI");
  await expect(row()).toBeVisible();
  await page.getByRole("textbox", { name: "Search", exact: true }).fill("");
  await folderButton(parentId).click();
  await row().hover();
  await page
    .getByRole("button", {
      name: `Actions for cluster ${cluster.name}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: `Move ${cluster.name}`,
    exact: true,
  });
  await drawer.getByLabel("Destination folder").selectOption(myId);
  await drawer.getByRole("button", { name: "Move", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(
    folder(myId).getByRole("button", {
      name: `Open console ${cluster.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    folder(myId).getByRole("button", {
      name: `Open console ${cluster.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/kubernetes-folders.png",
    fullPage: true,
  });
  await page.goto("/settings/kubernetes");
  await page
    .getByRole("button", { name: `Edit ${cluster.name}`, exact: true })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Edit Kubernetes cluster",
    exact: true,
  });
  await expect(edit.getByLabel("Cluster folder", { exact: true })).toHaveValue(
    myId,
  );
  await edit.getByLabel("Cluster folder", { exact: true }).selectOption(devId);
  await edit.getByRole("button", { name: "Save cluster", exact: true }).click();
  await expect(edit).toBeHidden();
  expect(edits[0]).toMatchObject({
    groupId: devId,
    vpnProfileId: null,
    bastionId: null,
  });
  expect(edits[0]).not.toHaveProperty("kubeconfig");
  await page.goto("/");
  await folderButton(devId).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "New Kubernetes cluster", exact: true })
    .click();
  const add = page.getByRole("dialog", {
    name: "Add Kubernetes cluster",
    exact: true,
  });
  await expect(add.getByLabel("Cluster folder", { exact: true })).toHaveValue(
    devId,
  );
  await add.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto("/");
  await folderButton(devId).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("dialog", {
    name: "Delete Folder",
    exact: true,
  });
  await expect(confirm).toContainText("Kubernetes clusters");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(folder(devId)).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Kubernetes clusters", exact: true })
      .getByRole("button", {
        name: `Open console ${cluster.name}`,
        exact: true,
      }),
  ).toBeVisible();
  expect(deletedClusters).toBe(0);
});
