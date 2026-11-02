import { describe, expect, it } from "vitest";
import { planCommand } from "../../packages/kubernetes/commands.js";
import { parseOperation } from "../../packages/shared/operations.js";
import { needsApproval } from "../../packages/policy-engine/index.js";
const plan = (command: string[], manifest?: string) =>
  planCommand({ command, manifest }, "apps");
describe("kubectl command planning", () => {
  it("scopes and paginates reads, encodes selectors/cursors, and supports named JSON inspection", () => {
    expect(plan(["kubectl", "get", "po", "-n", "production"]).path).toBe(
      "/api/v1/namespaces/production/pods?limit=100",
    );
    const url = new URL(
      plan(["get", "deployments", "-A", "--selector=a&b=1", "--continue=x&y=2"])
        .path,
      "https://fixture.test",
    );
    expect(url.pathname).toBe("/apis/apps/v1/deployments");
    expect(url.searchParams.get("labelSelector")).toBe("a&b=1");
    expect(url.searchParams.get("continue")).toBe("x&y=2");
    expect(plan(["describe", "pod/api-1"])).toEqual({
      method: "GET",
      path: "/api/v1/namespaces/apps/pods/api-1",
    });
    expect(plan(["logs", "api-1", "-c", "api", "--tail=50"]).path).toContain(
      "/pods/api-1/log?container=api&tailLines=50",
    );
  });
  it("plans scale/restart/delete and inline patches without a local process", () => {
    const scale = plan(["scale", "deploy/api", "--replicas=3"]);
    expect(scale.path).toBe(
      "/apis/apps/v1/namespaces/apps/deployments/api/scale",
    );
    expect(JSON.parse(scale.body!)).toEqual({ spec: { replicas: 3 } });
    expect(plan(["rollout", "restart", "deploy/api"]).contentType).toBe(
      "application/strategic-merge-patch+json",
    );
    expect(plan(["delete", "pod/api-1"]).method).toBe("DELETE");
    expect(
      plan([
        "patch",
        "deploy/api",
        "--type=merge",
        "-p",
        '{"spec":{"replicas":0}}',
      ]).body,
    ).toBe('{"spec":{"replicas":0}}');
  });
  it("accepts a single supported inline manifest and checks namespace conflicts", () => {
    const manifest =
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\ndata:\n  message: hello\n";
    const apply = plan(["apply", "-f", "-"], manifest);
    expect(apply).toMatchObject({
      path: "/api/v1/namespaces/apps/configmaps/settings?fieldManager=nexusssh",
      method: "PATCH",
      contentType: "application/apply-patch+yaml",
    });
    expect(() =>
      planCommand(
        {
          command: ["apply", "-f", "-"],
          namespace: "other",
          manifest: manifest.replace(
            "  name: settings",
            "  name: settings\n  namespace: apps",
          ),
        },
        "apps",
      ),
    ).toThrow(/namespace/);
    expect(() =>
      plan(["apply", "-f", "-"], manifest + "---\n" + manifest),
    ).toThrow();
    expect(() => plan(["apply", "-f", "-"], "a: &a hi\nb: *a")).toThrow();
  });
  it.each([
    ["get", "pods", "--server=https://evil.test"],
    ["get", "pods", "--kubeconfig=/etc/secret"],
    ["get", "pods", "--token=other"],
    ["get", "--raw=/api/v1/secrets"],
    ["proxy"],
    ["exec", "pod/api", "--", "sh"],
    ["apply", "-f", "/etc/secret"],
    ["apply", "-f", "https://evil.test"],
    ["delete", "pods", "--all"],
    ["get", "pods/../../secrets"],
    ["scale", "deploy/api", "--replicas=-1"],
    ["logs", "api", "-c", "app", "--follow"],
    ["get", "pods", "-o=go-template=anything"],
    ["patch", "deploy/api", "--patch-file=/etc/secret"],
    ["get", "pods", ";", "curl"],
    ["get", "pods", "-n=apps", "--namespace=other"],
  ])("rejects unsupported/unsafe argv %j", (...command) =>
    expect(() => plan(command)).toThrow(),
  );
  it("requires command approvals, bounded timeouts, explicit container, and strict schemas", () => {
    expect(needsApproval("kubernetes_execute")).toBe(true);
    expect(needsApproval("kubernetes_pod_exec")).toBe(true);
    const clusterId = "a36f3487-d487-4e9a-9286-12a1f82342bf";
    expect(() =>
      parseOperation("kubernetes_pod_exec", {
        clusterId,
        namespace: "apps",
        pod: "api",
        command: ["id"],
      }),
    ).toThrow();
    expect(() =>
      parseOperation("kubernetes_execute", {
        clusterId,
        command: ["get", "pods"],
        timeoutMs: 60001,
      }),
    ).toThrow();
    expect(() =>
      parseOperation("kubernetes_execute", {
        clusterId,
        command: ["get", "pods"],
        server: "https://evil.test",
      }),
    ).toThrow();
  });
});
