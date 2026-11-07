import { describe, expect, it, vi } from "vitest";
import {
  failClaimedTask,
  failQueuedTask,
  taskCancelled,
} from "../../apps/api/src/task-lifecycle.js";

const task = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  principalId: "agent-1",
  organizationId: "org-1",
  serverId: "server-1",
  operation: "ssh_execute",
  tokenId: "token-1",
  batchId: null,
  status: "running",
  expiresAt: new Date(Date.now() + 60000),
  ...overrides,
});

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-1",
  organizationId: "org-1",
  level: "operator",
  revoked: false,
  owner: { disabled: false, role: "owner" },
  ...overrides,
});

const token = (scopes = ["ssh_execute"]) => ({
  id: "token-1",
  scopes: JSON.stringify(scopes),
});

const grant = (operations = ["ssh_execute"]) => ({
  operations: JSON.stringify(operations),
});

function store(overrides: Record<string, unknown> = {}) {
  return {
    agent: { findUnique: vi.fn(async () => agent()) },
    user: { findFirst: vi.fn(async () => null) },
    agentToken: { findFirst: vi.fn(async () => token()) },
    agentPermission: { findUnique: vi.fn(async () => grant()) },
    batchDispatch: { findUnique: vi.fn(async () => null) },
    ...overrides,
  } as any;
}

describe("live task access", () => {
  it("keeps an active agent task running", async () => {
    await expect(taskCancelled(task(), store())).resolves.toBe(false);
  });

  it("stops when the token is revoked or the operation leaves its scope", async () => {
    await expect(
      taskCancelled(
        task(),
        store({ agentToken: { findFirst: vi.fn(async () => null) } }),
      ),
    ).resolves.toBe(true);
    await expect(
      taskCancelled(
        task(),
        store({
          agentToken: {
            findFirst: vi.fn(async () => token(["ssh_read_file"])),
          },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("stops when a non-administrator loses the server grant", async () => {
    const calls: unknown[] = [];
    const fake = store({
      agentPermission: {
        findUnique: vi.fn(async (args) => {
          calls.push(args);
          return null;
        }),
      },
    });
    await expect(taskCancelled(task(), fake)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not require a grant for administrator tokens", async () => {
    const fake = store({
      agent: {
        findUnique: vi.fn(async () =>
          agent({
            level: "administrator",
            owner: { disabled: false, role: "administrator" },
          }),
        ),
      },
      agentToken: {
        findFirst: vi.fn(async () => token(["workspace_admin", "ssh_execute"])),
      },
      agentPermission: { findUnique: vi.fn(async () => null) },
    });
    await expect(taskCancelled(task(), fake)).resolves.toBe(false);
    expect(fake.agentPermission.findUnique).not.toHaveBeenCalled();
  });

  it("requires both batch scopes for a batch task", async () => {
    const fake = store({
      agentToken: { findFirst: vi.fn(async () => token(["ssh_execute"])) },
    });
    await expect(
      taskCancelled(task({ batchId: "batch-1" }), fake),
    ).resolves.toBe(true);
  });

  it("stops revoked agents, expired tasks and missing users", async () => {
    await expect(
      taskCancelled(
        task(),
        store({
          agent: { findUnique: vi.fn(async () => agent({ revoked: true })) },
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      taskCancelled(task({ expiresAt: new Date(Date.now() - 1) }), store()),
    ).resolves.toBe(true);
    await expect(
      taskCancelled(
        task({ tokenId: null }),
        store({ agent: { findUnique: vi.fn(async () => null) } }),
      ),
    ).resolves.toBe(true);
  });
});

function transactionStore(count = 1) {
  const tx = {
    backgroundTask: { updateMany: vi.fn(async () => ({ count })) },
    commandExecution: { updateMany: vi.fn(async () => ({ count })) },
    auditEvent: { updateMany: vi.fn(async () => ({ count })) },
  };
  return {
    store: {
      $transaction: async (work: (client: typeof tx) => Promise<unknown>) =>
        work(tx),
    } as any,
    tx,
  };
}

describe("unstarted task cleanup", () => {
  it("releases a claim that failed after the running transition", async () => {
    const { store: fake, tx } = transactionStore();
    const identity = {
      id: "task-1",
      organizationId: "org-1",
      principalId: "agent-1",
      operation: "ssh_execute",
      leaseHash: "lease-hash",
    };
    await expect(failClaimedTask(identity, fake)).resolves.toBe(true);
    expect(tx.backgroundTask.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "running", leaseHash: "lease-hash" },
      data: { status: "failed", leaseHash: null },
    });
    expect(tx.commandExecution.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "running" },
      data: { status: "failed" },
    });
    expect(tx.auditEvent.updateMany).toHaveBeenCalledWith({
      where: {
        correlationId: "task-1",
        organizationId: "org-1",
        principalId: "agent-1",
        action: "ssh_execute",
        status: "queued",
      },
      data: { status: "failed" },
    });
  });

  it("fails a queued task that was never submitted to the queue", async () => {
    const { store: fake, tx } = transactionStore();
    await expect(
      failQueuedTask(
        {
          id: "task-1",
          organizationId: "org-1",
          principalId: "agent-1",
          operation: "ssh_execute",
        },
        fake,
      ),
    ).resolves.toBe(true);
    expect(tx.backgroundTask.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "queued" },
      data: { status: "failed" },
    });
    expect(tx.auditEvent.updateMany).toHaveBeenCalledWith({
      where: {
        correlationId: "task-1",
        organizationId: "org-1",
        principalId: "agent-1",
        action: "ssh_execute",
        status: "queued",
      },
      data: { status: "failed" },
    });
  });

  it("does not touch records another request already changed", async () => {
    const { store: fake, tx } = transactionStore(0);
    await expect(
      failQueuedTask(
        {
          id: "task-1",
          organizationId: "org-1",
          principalId: "agent-1",
          operation: "ssh_execute",
        },
        fake,
      ),
    ).resolves.toBe(false);
    expect(tx.commandExecution.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.updateMany).not.toHaveBeenCalled();
  });
});
