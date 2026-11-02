import { it, expect } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { seal, unseal } from "../../packages/shared/crypto.js";

it("migrates fresh and existing databases without changing encrypted SSH identities or cluster credentials", async () => {
  const dataRoot = resolve("data");
  mkdirSync(dataRoot, { recursive: true });
  const directory = mkdtempSync(join(dataRoot, "kubernetes-migration-"));
  const migrations = resolve("packages/database/prisma/migrations");
  let client: PrismaClient | undefined;
  const migrate = (schema: string, url: string) => {
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
        env: { ...process.env, DATABASE_URL: url },
        timeout: 30000,
      },
    );
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
  };
  try {
    copyFileSync(
      "packages/database/prisma/schema.prisma",
      join(directory, "schema.prisma"),
    );
    mkdirSync(join(directory, "migrations"));
    for (const entry of readdirSync(migrations, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name >= "20261101080000_kubernetes_routes") continue;
        mkdirSync(join(directory, "migrations", entry.name));
        copyFileSync(
          join(migrations, entry.name, "migration.sql"),
          join(directory, "migrations", entry.name, "migration.sql"),
        );
      } else
        copyFileSync(
          join(migrations, entry.name),
          join(directory, "migrations", entry.name),
        );
    }
    // The application migration wrapper also creates SQLite files first.
    writeFileSync(join(directory, "upgrade.db"), "");
    migrate(join(directory, "schema.prisma"), "file:./upgrade.db");
    const databaseURL = `file:../../../data/${basename(directory)}/upgrade.db`;
    client = new PrismaClient({ datasources: { db: { url: databaseURL } } });
    const organization = await client.organization.create({
      data: { name: "Migration fixture" },
    });
    const encryptionKey = randomBytes(32).toString("hex");
    const secret = seal(
      { password: "disposable-migration-password" },
      encryptionKey,
      "legacy-identity",
    );
    const identity = await client.sSHIdentity.create({
      data: {
        organizationId: organization.id,
        name: "Existing identity",
        kind: "password",
        encryptedSecret: secret,
      },
    });
    const clusterId = randomUUID();
    const clusterSecret = seal(
      { token: "existing-cluster-secret" },
      encryptionKey,
      `${organization.id}:kubernetes:${clusterId}`,
    );
    // Seed the previous cluster schema before its optional route columns exist.
    await client.$executeRaw`INSERT INTO "KubernetesCluster" ("id", "updatedAt", "organizationId", "name", "server", "context", "authentication", "encryptedConfig") VALUES (${clusterId}, CURRENT_TIMESTAMP, ${organization.id}, 'Existing cluster', 'https://fixture.test', 'fixture', 'token', ${clusterSecret})`;
    await client.$disconnect();
    client = undefined;
    migrate("packages/database/prisma/schema.prisma", databaseURL);
    client = new PrismaClient({ datasources: { db: { url: databaseURL } } });
    expect(
      (
        await client.sSHIdentity.findUniqueOrThrow({
          where: { id: identity.id },
        })
      ).encryptedSecret,
    ).toBe(secret);
    expect(unseal(secret, encryptionKey, "legacy-identity")).toEqual({
      password: "disposable-migration-password",
    });
    const existingCluster = await client.kubernetesCluster.findUniqueOrThrow({
      where: { id: clusterId },
    });
    expect(existingCluster).toMatchObject({
      encryptedConfig: clusterSecret,
      vpnProfileId: null,
      bastionId: null,
      groupId: null,
    });
    expect(
      unseal(
        existingCluster.encryptedConfig,
        encryptionKey,
        `${organization.id}:kubernetes:${clusterId}`,
      ),
    ).toEqual({ token: "existing-cluster-secret" });
    const parent = await client.serverGroup.create({
      data: { organizationId: organization.id, name: "SLUDI" },
    });
    const folder = await client.serverGroup.create({
      data: {
        organizationId: organization.id,
        name: "DEV",
        parentId: parent.id,
      },
    });
    await client.kubernetesCluster.update({
      where: { id: clusterId },
      data: { groupId: folder.id },
    });
    await client.serverGroup.update({
      where: { id: folder.id },
      data: { parentId: null, name: "Development" },
    });
    expect(
      (
        await client.kubernetesCluster.findUniqueOrThrow({
          where: { id: clusterId },
        })
      ).groupId,
    ).toBe(folder.id);
    await client.serverGroup.delete({ where: { id: folder.id } });
    expect(
      await client.kubernetesCluster.findUniqueOrThrow({
        where: { id: clusterId },
      }),
    ).toMatchObject({ groupId: null, encryptedConfig: clusterSecret });
    const cluster = await client.kubernetesCluster.create({
      data: {
        organizationId: organization.id,
        name: "Cluster fixture",
        server: "https://cluster.example.test",
        context: "fixture",
        authentication: "token",
        encryptedConfig: seal(
          { token: "disposable-cluster-token" },
          encryptionKey,
          "fixture-cluster",
        ),
      },
    });
    expect(cluster).toMatchObject({ status: "unknown", namespace: "default" });
    await client.$disconnect();
    client = undefined;
    writeFileSync(join(directory, "fresh.db"), "");
    migrate(
      "packages/database/prisma/schema.prisma",
      `file:../../../data/${basename(directory)}/fresh.db`,
    );
  } finally {
    if (client) await client.$disconnect();
    if (
      resolve(directory).startsWith(dataRoot + sep) &&
      basename(directory).startsWith("kubernetes-migration-")
    )
      rmSync(directory, { recursive: true, force: true });
  }
});
