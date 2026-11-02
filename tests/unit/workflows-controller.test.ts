import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Request } from "express";
const fixture = vi.hoisted(() => ({
  db: undefined as unknown as PrismaClient,
  actor: {
    id: "",
    organizationId: "",
    kind: "user",
    role: "owner",
    scopes: [],
  },
}));
vi.mock("../../packages/database/index.js", () => ({
  db: new Proxy(
    {},
    {
      get: (_, key) => {
        const value = (fixture.db as any)[key];
        return typeof value === "function" ? value.bind(fixture.db) : value;
      },
    },
  ),
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: { ENCRYPTION_KEY: "ab".repeat(32) },
}));
vi.mock("../../apps/api/src/auth.js", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/auth.js")>()),
  authenticate: async () => fixture.actor,
}));
vi.mock("../../apps/api/src/domain.js", () => ({ audit: vi.fn() }));
import { WorkflowsController } from "../../apps/api/src/workflows.js";
const controller = new WorkflowsController(),
  req = {} as Request;
const root = resolve("data");
let directory: string;
beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  directory = mkdtempSync(join(root, "workflow-test-"));
  const url = "file:" + join(directory, "test.db").replaceAll("\\", "/");
  writeFileSync(join(directory, "test.db"), "");
  const migrated = spawnSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "packages/database/prisma/schema.prisma",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url },
      timeout: 30000,
    },
  );
  expect(migrated.status, migrated.stdout + migrated.stderr).toBe(0);
  fixture.db = new PrismaClient({ datasources: { db: { url } } });
});
beforeEach(() => {
  fixture.actor = {
    id: randomUUID(),
    organizationId: randomUUID(),
    kind: "user",
    role: "owner",
    scopes: [],
  };
});
afterAll(async () => {
  await fixture.db?.$disconnect();
  if (directory && dirname(directory) === root)
    rmSync(directory, { recursive: true, force: true });
});
describe("private workspace presets", () => {
  it("isolates users and workspaces and never accepts terminal credentials", async () => {
    const layout = {
      columns: 2,
      tabs: [{ kind: "terminal", serverId: randomUUID(), title: "App" }],
    };
    const saved = await controller.savePreset(req, { name: "On call", layout });
    expect(await controller.presets(req)).toMatchObject([
      { id: saved.id, layout },
    ]);
    fixture.actor.id = randomUUID();
    expect(await controller.presets(req)).toEqual([]);
    await controller.deletePreset(req, saved.id);
    expect(await fixture.db.workspacePreset.count()).toBe(1);
    await expect(
      controller.savePreset(req, {
        name: "Bad",
        layout: { ...layout, tabs: [{ ...layout.tabs[0], resume: "secret" }] },
      }),
    ).rejects.toThrow();
  });
});
describe("immutable runbooks", () => {
  it("versions templates, encrypts definitions and checks tenancy and administration", async () => {
    const first = await controller.saveRunbook(req, {
      name: "Service",
      definition: { template: "systemctl status -- {{service}}" },
    });
    const second = await controller.saveRunbook(req, {
      name: "Service",
      definition: { template: "systemctl is-active -- {{service}}" },
    });
    expect(second.version).toBe(2);
    expect(second.id).toBe(first.id);
    const old = await controller.definition(req, first.id, first.revisionId);
    expect(old.template).toBe("systemctl status -- {{service}}");
    const row = await fixture.db.runbookRevision.findUniqueOrThrow({
      where: { id: first.revisionId },
    });
    expect(row.encryptedDefinition).not.toContain("systemctl");
    expect(
      await controller.preview(req, first.id, first.revisionId, {
        service: "nginx; reboot",
      }),
    ).toMatchObject({
      command: "systemctl status -- 'nginx; reboot'",
      version: 1,
    });
    fixture.actor.role = "operator";
    await expect(
      controller.saveRunbook(req, {
        name: "Service",
        definition: { template: "reboot" },
      }),
    ).rejects.toThrow("Administrator");
    fixture.actor.organizationId = randomUUID();
    expect(await controller.runbooks(req)).toEqual([]);
    await expect(
      controller.definition(req, first.id, first.revisionId),
    ).rejects.toThrow("unavailable");
  });
});
