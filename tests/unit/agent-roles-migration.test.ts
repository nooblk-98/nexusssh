import { it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { administratorAgentScopes } from "../../packages/policy-engine/index.js";

it("migrates old agent roles without expanding restricted access or losing grants and tokens", async () => {
  const root = resolve("data");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "agent-role-migration-"));
  const url = `file:../../../data/${basename(directory)}/test.db`;
  let client: PrismaClient | undefined;
  const migrate = (schema: string, databaseURL: string) => {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/prisma/build/index.js",
        "migrate",
        "deploy",
        "--schema",
        schema,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseURL },
        timeout: 30000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  };
  try {
    copyFileSync(
      "packages/database/prisma/schema.prisma",
      join(directory, "schema.prisma"),
    );
    mkdirSync(join(directory, "migrations"));
    const source = resolve("packages/database/prisma/migrations");
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        copyFileSync(
          join(source, entry.name),
          join(directory, "migrations", entry.name),
        );
        continue;
      }
      if (entry.name >= "20261101090000_agent_roles") continue;
      mkdirSync(join(directory, "migrations", entry.name));
      copyFileSync(
        join(source, entry.name, "migration.sql"),
        join(directory, "migrations", entry.name, "migration.sql"),
      );
    }
    writeFileSync(join(directory, "test.db"), "");
    migrate(join(directory, "schema.prisma"), "file:./test.db");
    client = new PrismaClient({ datasources: { db: { url } } });
    const org = await client.organization.create({
      data: { name: "Role migration" },
    });
    const owner = await client.user.create({
      data: {
        organizationId: org.id,
        email: "migration@example.test",
        name: "Owner",
        passwordHash: "fixture",
        role: "owner",
      },
    });
    const identity = await client.sSHIdentity.create({
      data: {
        organizationId: org.id,
        name: "SSH",
        kind: "password",
        encryptedSecret: "encrypted-ssh-fixture",
      },
    });
    const server = await client.server.create({
      data: {
        organizationId: org.id,
        name: "SSH",
        host: "10.0.0.5",
        username: "test",
        identityId: identity.id,
      },
    });
    const cluster = await client.kubernetesCluster.create({
      data: {
        organizationId: org.id,
        name: "Cluster",
        server: "https://fixture.test",
        context: "fixture",
        authentication: "token",
        encryptedConfig: "encrypted-kube-fixture",
      },
      // Seed the old schema without selecting columns added by later migrations.
      select: { id: true },
    });
    const ids = new Map<string, string>();
    for (const level of ["viewer", "operator", "administrator", "custom"]) {
      const agent = await client.agent.create({
        data: {
          organizationId: org.id,
          ownerId: owner.id,
          name: level,
          level,
          maxCallsPerMinute: 7,
          permissions: {
            create: {
              serverId: server.id,
              operations: '["system_info","ssh_execute"]',
            },
          },
          clusterPermissions: {
            create: {
              clusterId: cluster.id,
              operations: '["kubernetes_clusters_list","kubernetes_pod_exec"]',
            },
          },
          tokens: {
            create: {
              tokenHash: level + "-unchanged-hash",
              scopes:
                '["system_info","ssh_execute","kubernetes_clusters_list","kubernetes_pod_exec","workspace_manage"]',
              issuer: "fixture",
              audience: "fixture",
              expiresAt: new Date("2030-01-01T00:00:00Z"),
            },
          },
        },
      });
      ids.set(level, agent.id);
    }
    await client.$disconnect();
    client = undefined;
    migrate("packages/database/prisma/schema.prisma", url);
    client = new PrismaClient({ datasources: { db: { url } } });
    for (const old of ["viewer", "operator", "administrator", "custom"]) {
      const row = await client.agent.findUniqueOrThrow({
        where: { id: ids.get(old)! },
        include: { permissions: true, clusterPermissions: true, tokens: true },
      });
      expect(row.level).toBe(
        old === "administrator" ? "administrator" : "custom",
      );
      expect(row.maxCallsPerMinute).toBe(7);
      expect(row.permissions).toHaveLength(1);
      expect(row.clusterPermissions).toHaveLength(1);
      expect(row.tokens).toHaveLength(1);
      expect(row.tokens[0]).toMatchObject({
        tokenHash: old + "-unchanged-hash",
        revoked: false,
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      });
      const scopes = JSON.parse(row.tokens[0].scopes);
      if (old === "administrator")
        expect(new Set(scopes)).toEqual(new Set(administratorAgentScopes));
      else expect(scopes).not.toContain("workspace_manage");
      if (old === "viewer") {
        expect(scopes).toEqual(["system_info", "kubernetes_clusters_list"]);
        expect(JSON.parse(row.permissions[0].operations)).toEqual([
          "system_info",
        ]);
        expect(JSON.parse(row.clusterPermissions[0].operations)).toEqual([
          "kubernetes_clusters_list",
        ]);
      } else if (old !== "administrator")
        expect(scopes).toContain("ssh_execute");
    }
    expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    const columns = await client.$queryRaw<any[]>`PRAGMA table_info('Agent')`;
    expect(columns.find((column) => column.name === "level").dflt_value).toBe(
      "'custom'",
    );
    await client.agent.delete({ where: { id: ids.get("viewer")! } });
    expect(
      await client.agentToken.count({ where: { agentId: ids.get("viewer") } }),
    ).toBe(0);
    expect(
      await client.agentPermission.count({
        where: { agentId: ids.get("viewer") },
      }),
    ).toBe(0);
    expect(
      await client.kubernetesAgentPermission.count({
        where: { agentId: ids.get("viewer") },
      }),
    ).toBe(0);
    expect(
      (
        await client.sSHIdentity.findUniqueOrThrow({
          where: { id: identity.id },
        })
      ).encryptedSecret,
    ).toBe("encrypted-ssh-fixture");
    expect(
      (
        await client.kubernetesCluster.findUniqueOrThrow({
          where: { id: cluster.id },
        })
      ).encryptedConfig,
    ).toBe("encrypted-kube-fixture");
  } finally {
    await client?.$disconnect();
    if (
      resolve(directory).startsWith(root + sep) &&
      basename(directory).startsWith("agent-role-migration-")
    )
      rmSync(directory, { recursive: true, force: true });
  }
});
