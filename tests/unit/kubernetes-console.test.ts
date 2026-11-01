import { describe, expect, it } from "vitest";
import { splitConsoleCommand } from "../../packages/kubernetes/console-input.js";
import {
  prepareConsoleCommand,
  formatConsoleResult,
} from "../../packages/kubernetes/console.js";

describe("Kubernetes command console", () => {
  it("preserves quoted inline patches and selectors without interpreting a shell", () => {
    const args = splitConsoleCommand(
      `kubectl patch deploy/api --type=merge -p '{"spec":{"replicas":2}}'`,
    );
    expect(prepareConsoleCommand({ command: args }, "apps").body).toBe(
      '{"spec":{"replicas":2}}',
    );
    expect(
      splitConsoleCommand('kubectl get pods -l "app=api,tier=web"'),
    ).toEqual(["kubectl", "get", "pods", "-l", "app=api,tier=web"]);
    expect(
      splitConsoleCommand(
        `kubectl patch cm/settings -p '{"data":{"text":"$(id); unchanged"}}'`,
      ).at(-1),
    ).toBe('{"data":{"text":"$(id); unchanged"}}');
    for (const input of [
      "kubectl get pods; id",
      "kubectl get pods | cat",
      "kubectl get pods $(id)",
      "kubectl get pods\nid",
      "kubectl get pods 'unterminated",
    ])
      expect(() => splitConsoleCommand(input)).toThrow();
  });
  it("runs version through a fixed endpoint and preserves the command restrictions", () => {
    expect(
      prepareConsoleCommand({ command: ["kubectl", "version"] }, "apps"),
    ).toEqual({ method: "GET", path: "/version" });
    for (const command of [
      ["version", "--server=https://other.test"],
      ["config", "view", "--raw"],
      ["get", "pods", "--kubeconfig=/secret"],
      ["exec", "api", "--", "sh"],
    ])
      expect(() => prepareConsoleCommand({ command }, "apps")).toThrow();
  });
  it("formats table, YAML and log output with pagination hints and a byte limit", () => {
    const table = {
      kind: "Table",
      columnDefinitions: [{ name: "Name" }, { name: "Ready" }],
      rows: [{ cells: ["api", "1/1"] }],
      metadata: { continue: "next&token" },
    };
    expect(formatConsoleResult(table, ["get", "pods"]).output).toContain(
      "api   1/1",
    );
    expect(formatConsoleResult(table, ["get", "pods"]).output).toContain(
      '"next&token"',
    );
    expect(
      formatConsoleResult({ kind: "Pod" }, ["get", "pod/api", "-o", "yaml"])
        .output,
    ).toBe("kind: Pod\n");
    expect(
      formatConsoleResult(
        { content: "x".repeat(300000), truncated: false },
        ["logs"],
        true,
      ),
    ).toMatchObject({ truncated: true, output: expect.any(String) });
    expect(
      Buffer.byteLength(
        formatConsoleResult({ content: "x".repeat(300000) }, [], true).output,
      ),
    ).toBe(256 * 1024);
  });
});
