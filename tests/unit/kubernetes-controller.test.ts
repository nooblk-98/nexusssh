import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { unseal } from "../../packages/shared/crypto.js";

const fixture = vi.hoisted(() => ({
  actor: {
    id: "owner",
    organizationId: "org-a",
    role: "owner",
    disabled: false,
  },
  rows: new Map<string, any>(),
  audit: [] as any[],
  remote: vi.fn(),
  encryptionKey: "ab".repeat(32),
}));

vi.mock("../../packages/shared/config.js", () => ({
  config: {
    ENCRYPTION_KEY: fixture.encryptionKey,
    KUBERNETES_ALLOWED_CIDRS: "127.0.0.1/32",
    MCP_AUTH_ISSUER: "fixture-issuer",
  },
  mcpAudience: "fixture-audience",
}));
vi.mock("../../packages/kubernetes/client.js", async (original) => ({
  ...(await original<typeof import("../../packages/kubernetes/client.js")>()),
  kubernetesRequest: fixture.remote,
}));
vi.mock("../../packages/database/index.js", () => {
  const selected = (row: any, selection?: Record<string, unknown>) =>
    row && selection
      ? Object.fromEntries(
          Object.entries(selection)
            .filter(([, value]) => value === true)
            .map(([key]) => [key, row[key]]),
        )
      : row;
  return {
    db: {
      webSession: {
        findUnique: vi.fn(async () => ({
          userId: fixture.actor.id,
          user: fixture.actor,
          expiresAt: new Date(Date.now() + 60000),
        })),
      },
      agentToken: {
        findUnique: vi.fn(async () => ({
          agentId: "agent",
          id: "agent-token",
          revoked: false,
          expiresAt: new Date(Date.now() + 60000),
          scopes: "[]",
          issuer: "fixture-issuer",
          audience: "fixture-audience",
          agent: {
            id: "agent",
            organizationId: "org-a",
            level: "administrator",
            revoked: false,
            ownerId: "owner",
            owner: { disabled: false, role: "owner" },
          },
        })),
      },
      auditEvent: {
        create: vi.fn(async ({ data }) => {
          fixture.audit.push(data);
          return data;
        }),
      },
      kubernetesCluster: {
        findMany: vi.fn(async ({ where, select }) =>
          [...fixture.rows.values()]
            .filter((row) => row.organizationId === where.organizationId)
            .map((row) => selected(row, select)),
        ),
        findFirst: vi.fn(async ({ where, select }) => {
          const row = fixture.rows.get(where.id);
          return row?.organizationId === where.organizationId
            ? selected(row, select)
            : null;
        }),
        count: vi.fn(
          async ({ where }) =>
            [...fixture.rows.values()].filter(
              (row) => row.organizationId === where.organizationId,
            ).length,
        ),
        create: vi.fn(async ({ data, select }) => {
          if (
            [...fixture.rows.values()].some(
              (row) =>
                row.organizationId === data.organizationId &&
                row.name === data.name,
            )
          )
            throw { code: "P2002" };
          const row = {
            description: "",
            status: "unknown",
            version: null,
            lastError: null,
            lastCheckedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          fixture.rows.set(row.id, row);
          return selected(row, select);
        }),
        update: vi.fn(async ({ where, data, select }) => {
          const row = {
            ...fixture.rows.get(where.id),
            ...data,
            updatedAt: new Date(),
          };
          fixture.rows.set(row.id, row);
          return selected(row, select);
        }),
        delete: vi.fn(async ({ where }) => {
          fixture.rows.delete(where.id);
        }),
      },
    },
  };
});

import { KubernetesController } from "../../apps/api/src/kubernetes.js";
import { KubernetesError } from "../../packages/kubernetes/client.js";

const request = {
  headers: {},
  cookies: { nexus_session: "fixture-session" },
  method: "GET",
  originalUrl: "/api/kubernetes/clusters",
} as Request;
const source = (token = "fixture-token") =>
  JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    "current-context": "fixture",
    clusters: [
      { name: "api", cluster: { server: "https://cluster.example.test:6443" } },
    ],
    users: [{ name: "reader", user: { token } }],
    contexts: [
      {
        name: "fixture",
        context: { cluster: "api", user: "reader", namespace: "apps" },
      },
    ],
  });
beforeEach(() => {
  fixture.actor = {
    id: "owner",
    organizationId: "org-a",
    role: "owner",
    disabled: false,
  };
  fixture.rows.clear();
  fixture.audit.length = 0;
  fixture.remote.mockReset();
});

describe("Kubernetes profile and access controls", () => {
  it("encrypts imported credentials, returns summaries only, and binds ciphertext to its workspace and cluster", async () => {
    const controller = new KubernetesController();
    const created = await controller.create(request, {
      name: "Development",
      kubeconfig: source(),
    });
    const stored = fixture.rows.get(created.id);
    expect(stored.encryptedConfig).not.toContain("fixture-token");
    expect(
      unseal(
        stored.encryptedConfig,
        fixture.encryptionKey,
        `org-a:kubernetes:${created.id}`,
      ),
    ).toMatchObject({ token: "fixture-token" });
    expect(() =>
      unseal(
        stored.encryptedConfig,
        fixture.encryptionKey,
        `org-b:kubernetes:${created.id}`,
      ),
    ).toThrow();
    expect(JSON.stringify(created)).not.toMatch(
      /fixture-token|encryptedConfig|client-key/,
    );
    expect(JSON.stringify(await controller.list(request))).not.toContain(
      "fixture-token",
    );
    expect(fixture.remote).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.audit)).not.toContain("fixture-token");
  });

  it("retains credentials on metadata edits and resets connection status when credentials rotate", async () => {
    const controller = new KubernetesController();
    const created = await controller.create(request, {
      name: "Development",
      kubeconfig: source(),
    });
    const original = fixture.rows.get(created.id).encryptedConfig;
    await controller.update(request, created.id, {
      name: "Renamed",
      description: "Updated",
    });
    expect(fixture.rows.get(created.id).encryptedConfig).toBe(original);
    fixture.remote.mockResolvedValue({ gitVersion: "v1.34.0" });
    await expect(controller.check(request, created.id)).resolves.toMatchObject({
      status: "connected",
      version: "v1.34.0",
    });
    await controller.update(request, created.id, {
      kubeconfig: source("rotated-fixture-token"),
    });
    expect(fixture.rows.get(created.id)).toMatchObject({
      status: "unknown",
      version: null,
      lastError: null,
      lastCheckedAt: null,
    });
    expect(
      unseal(
        fixture.rows.get(created.id).encryptedConfig,
        fixture.encryptionKey,
        `org-a:kubernetes:${created.id}`,
      ),
    ).toMatchObject({ token: "rotated-fixture-token" });
    await controller.remove(request, created.id);
    expect(fixture.rows.size).toBe(0);
  });

  it("denies non-administrators and administrator agents and isolates organizations", async () => {
    const controller = new KubernetesController();
    const created = await controller.create(request, {
      name: "Development",
      kubeconfig: source(),
    });
    for (const role of ["viewer", "operator"]) {
      fixture.actor.role = role;
      await expect(controller.list(request)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        controller.create(request, { name: "No", kubeconfig: source() }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    fixture.actor.role = "owner";
    fixture.actor.organizationId = "org-b";
    await expect(controller.list(request)).resolves.toEqual([]);
    await expect(controller.check(request, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      controller.update(request, created.id, { name: "No" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.remove(request, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const agentRequest = {
      ...request,
      cookies: {},
      headers: { authorization: "Bearer fixture-agent" },
    } as Request;
    await expect(controller.list(agentRequest)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(fixture.remote).not.toHaveBeenCalled();
  });

  it("uses fixed scoped read paths, supports cursors, and exposes no raw pod specs", async () => {
    const controller = new KubernetesController();
    const created = await controller.create(request, {
      name: "Development",
      kubeconfig: source(),
    });
    fixture.remote.mockResolvedValue({
      items: [
        {
          metadata: { name: "api", namespace: "apps" },
          spec: {
            containers: [
              {
                name: "api",
                image: "app:v1",
                env: [{ value: "do-not-expose" }],
              },
            ],
          },
        },
      ],
      metadata: { continue: "next-page" },
    });
    const result = await controller.listResources(request, created.id, "pods", {
      namespace: "apps",
      cursor: "opaque&injected=1",
    });
    expect(result.nextCursor).toBe("next-page");
    expect(JSON.stringify(result)).not.toContain("do-not-expose");
    const path = new URL(
      fixture.remote.mock.calls[0][1],
      "https://fixture.invalid",
    );
    expect(path.pathname).toBe("/api/v1/namespaces/apps/pods");
    expect(path.searchParams.get("continue")).toBe("opaque&injected=1");
    await expect(
      controller.listResources(request, created.id, "secrets", {}),
    ).rejects.toThrow();
    await expect(
      controller.listResources(request, created.id, "pods", {
        namespace: "../../secrets",
      }),
    ).rejects.toThrow();
    expect(fixture.remote).toHaveBeenCalledTimes(1);
    fixture.remote.mockResolvedValue({
      content: "log output",
      truncated: false,
    });
    await controller.logs(request, created.id, "apps", "api-1", {
      container: "api",
      lines: "200",
    });
    const logs = new URL(
      fixture.remote.mock.calls[1][1],
      "https://fixture.invalid",
    );
    expect(logs.pathname).toBe("/api/v1/namespaces/apps/pods/api-1/log");
    expect(logs.searchParams.get("limitBytes")).toBe("262144");
    expect(logs.searchParams.has("follow")).toBe(false);
  });

  it("limits concurrent remote requests and releases the slots after failure", async () => {
    const controller = new KubernetesController();
    const created = await controller.create(request, {
      name: "Development",
      kubeconfig: source(),
    });
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    fixture.remote.mockReturnValue(pending);
    const reads = Array.from({ length: 4 }, () =>
      controller.listResources(request, created.id, "pods", {}),
    );
    await vi.waitFor(() => expect(fixture.remote).toHaveBeenCalledTimes(4));
    await expect(
      controller.listResources(request, created.id, "pods", {}),
    ).rejects.toThrow(/Too many active/);
    release({ items: [], metadata: {} });
    await Promise.all(reads);
    fixture.remote.mockRejectedValueOnce(
      new KubernetesError("TLS connection failed."),
    );
    await expect(controller.check(request, created.id)).rejects.toThrow(
      "TLS connection failed.",
    );
    expect(fixture.rows.get(created.id)).toMatchObject({
      status: "error",
      lastError: "TLS connection failed.",
    });
    fixture.remote.mockResolvedValue({ items: [], metadata: {} });
    await expect(
      controller.listResources(request, created.id, "pods", {}),
    ).resolves.toMatchObject({ items: [] });
  });
});
