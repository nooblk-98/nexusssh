import { stringify } from "yaml";
import { planCommand, type CommandPlan } from "./commands.js";
import { kubernetesRequest } from "./client.js";
import type { ClusterConnection } from "./kubeconfig.js";
import type { KubernetesNetwork } from "./network.js";

export function prepareConsoleCommand(
  input: { command: string[]; namespace?: string; manifest?: string },
  defaultNamespace: string,
): CommandPlan {
  const command =
    input.command[0] === "kubectl" ? input.command.slice(1) : input.command;
  if (
    command.length === 1 &&
    command[0] === "version" &&
    input.manifest === undefined
  )
    return { path: "/version", method: "GET" };
  return planCommand(input, defaultNamespace);
}

export function runConsoleCommand(
  connection: ClusterConnection,
  plan: CommandPlan,
  cidrs: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    route?: KubernetesNetwork;
    accept?: string;
  },
) {
  return kubernetesRequest(connection, plan.path, cidrs, plan.text, {
    ...plan,
    ...options,
  });
}

export function formatConsoleResult(
  data: any,
  command: string[],
  text = false,
) {
  let output: string;
  if (text) output = data.content || "";
  else if (
    data?.kind === "Table" &&
    Array.isArray(data.columnDefinitions) &&
    Array.isArray(data.rows)
  ) {
    const columns = data.columnDefinitions
      .map((column: any, index: number) => ({ ...column, index }))
      .filter((column: any) => !column.priority);
    const cell = (value: unknown) =>
      String(value ?? "<none>")
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .slice(0, 200);
    const rows: string[][] = [
      columns.map((column: any) => cell(column.name).toUpperCase()),
      ...data.rows.map((row: any) =>
        columns.map((column: any) => cell(row.cells?.[column.index])),
      ),
    ];
    const widths = columns.map((_: any, index: number) =>
      Math.min(200, Math.max(...rows.map((row) => row[index].length))),
    );
    output = data.rows.length
      ? rows
          .map((row) =>
            row
              .map((value, index) => value.padEnd(widths[index]))
              .join("  ")
              .trimEnd(),
          )
          .join("\n")
      : "No resources found.";
    if (data.metadata?.continue)
      output += `\n\nMore results available. Continue with --continue and cursor: ${JSON.stringify(data.metadata.continue)}`;
  } else if (
    command.some(
      (part, index) =>
        part === "-o=yaml" ||
        part === "--output=yaml" ||
        (part === "yaml" && ["-o", "--output"].includes(command[index - 1])),
    )
  )
    output = stringify(data, { lineWidth: 0 });
  else output = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(output);
  const truncated = buffer.length > 256 * 1024 || !!(text && data.truncated);
  return { output: buffer.subarray(0, 256 * 1024).toString("utf8"), truncated };
}
