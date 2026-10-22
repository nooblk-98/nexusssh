import { test, expect, type Locator } from "@playwright/test";

test("create subfolders, drag folders and servers, and persist moves", async ({
  page,
  baseURL,
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
  const nav = page.getByRole("navigation", { name: "Servers", exact: true });
  const prefix = "Folders " + Date.now();
  const ids: string[] = [];
  let serverId = "";
  const api = async (path: string, method = "GET", data?: unknown) => {
    const r = await page.request.fetch(baseURL + "/api/" + path, {
      method,
      data,
      headers: { origin: baseURL! },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const folder = (id: string) => nav.locator(`[data-folder-id="${id}"]`);
  const folderButton = (id: string) => folder(id).locator(":scope > button");
  const create = async (name: string, parent?: string) => {
    if (parent) {
      await folderButton(parent).click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "New Subfolder", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("menuitem", { name: "Folder", exact: true }).click();
    }
    await page.getByLabel("Folder name").fill(name);
    const saved = page.waitForResponse(
      (r) => r.url().endsWith("/api/groups") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const response = await saved;
    expect(response.ok()).toBeTruthy();
    const { id } = await response.json();
    ids.push(id);
    await expect(folderButton(id)).toBeVisible();
    return id as string;
  };
  const dragToRoot = async (source: Locator) => {
    await source.scrollIntoViewIfNeeded();
    const box = (await source.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 55, box.y + box.height / 2 + 8, { steps: 5 });
    const root = nav.getByText("Move to top level", { exact: true });
    await expect(root).toBeVisible();
    await root.hover();
    await page.mouse.up();
  };
  try {
    const a = await create(prefix + " A");
    const b = await create(prefix + " B");
    const child = await create("Services", a);
    const leaf = await create("Production", child);
    const identities = await api("identities");
    expect(identities.length).toBeGreaterThan(0);
    const server = await api("servers", "POST", {
      name: prefix + " server",
      host: "folder-fixture.invalid",
      port: 22,
      username: "root",
      fileRoot: "/root",
      identityId: identities[0].id,
      groupId: child,
    });
    serverId = server.id;
    await page.reload();
    const serverRow = nav.locator(`[data-server-id="${serverId}"]`);
    await expect(
      folder(child).locator(`[data-server-id="${serverId}"]`),
    ).toBeVisible();
    await serverRow.dragTo(folderButton(leaf));
    await expect(
      folder(leaf).locator(`[data-server-id="${serverId}"]`),
    ).toBeVisible();
    await folderButton(child).dragTo(folderButton(b));
    await expect(
      folder(b).locator(`[data-folder-id="${child}"]`),
    ).toBeVisible();
    await expect(
      folder(b).locator(`[data-server-id="${serverId}"]`),
    ).toBeVisible();
    await page.reload();
    await expect(folder(b).locator(`[data-folder-id="${leaf}"]`)).toBeVisible();
    await folderButton(child).dragTo(folderButton(leaf));
    expect(
      (await api("groups")).find((g: { id: string }) => g.id === child)
        .parentId,
    ).toBe(b);
    await dragToRoot(serverRow);
    await expect(
      nav.locator(`:scope > [data-server-id="${serverId}"]`),
    ).toBeVisible();
    await dragToRoot(folderButton(child));
    await expect(
      nav.locator(`:scope > [data-folder-id="${child}"]`),
    ).toBeVisible();
    await serverRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await page.getByLabel("Destination folder").selectOption(leaf);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(
      folder(leaf).locator(`[data-server-id="${serverId}"]`),
    ).toBeVisible();
    await folderButton(child).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await expect(
      page.getByLabel("Destination folder").locator(`option[value="${leaf}"]`),
    ).toHaveCount(0);
    await page.getByLabel("Destination folder").selectOption(a);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(folder(a).locator(`[data-folder-id="${leaf}"]`)).toBeVisible();
    await folderButton(a).click();
    await page.locator("#server-search").fill(prefix + " server");
    await expect(
      folder(leaf).locator(`[data-server-id="${serverId}"]`),
    ).toBeVisible();
    await page.locator("#server-search").fill("Production");
    await expect(serverRow).toBeVisible();
    await page.locator("#server-search").fill("");
    await folderButton(a).click();
    await page.screenshot({
      path: "test-results/nested-folders.png",
      fullPage: true,
    });
    await page.reload();
    await expect(
      folder(a).locator(`[data-server-id="${serverId}"]`),
    ).toBeVisible();
  } finally {
    if (serverId) await api("servers/" + serverId, "DELETE");
    for (const id of ids.reverse()) await api("groups/" + id, "DELETE");
  }
});
