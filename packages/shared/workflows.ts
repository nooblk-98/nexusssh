import { z } from "zod";

export const presetLayout = z
  .object({
    columns: z.number().int().min(1).max(4),
    tabs: z
      .array(
        z
          .object({
            kind: z.enum(["terminal", "sftp", "editor", "kubernetes"]),
            serverId: z.uuid(),
            title: z.string().min(1).max(200),
            path: z.string().max(4096).optional(),
            namespace: z.string().max(253).optional(),
          })
          .strict()
          .refine(
            (tab) => tab.kind !== "editor" || !!tab.path,
            "Editor tabs need a file path",
          ),
      )
      .max(30),
  })
  .strict();
export type PresetLayout = z.infer<typeof presetLayout>;

export const runbookDefinition = z
  .object({
    template: z.string().trim().min(1).max(4096),
    timeoutMs: z.number().int().min(100).max(60000).default(30000),
  })
  .strict();
export type RunbookDefinition = z.infer<typeof runbookDefinition>;
export function runbookParameters(template: string): string[] {
  // Keep substitution in ordinary shell arguments. Here-documents and nested
  // shell evaluation have different quoting rules, so they aren't templates.
  if (/[\r\n`]|<<|\$\(|[<>]\(/.test(template))
    throw new Error(
      "Use a single-line template without heredocs or command substitutions.",
    );
  const names = new Set<string>();
  let quote = "",
    escaped = false;
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (escaped) {
      if (template.slice(i).startsWith("{{"))
        throw new Error("Parameters cannot be escaped.");
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === quote) {
      quote = "";
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (template.slice(i).startsWith("{{")) {
      const match = /^\{\{([A-Za-z][A-Za-z0-9_]{0,31})\}\}/.exec(
        template.slice(i),
      );
      if (!match || quote)
        throw new Error(
          "Use {{parameter}} outside quotes; values are quoted automatically.",
        );
      names.add(match[1]);
      i += match[0].length - 1;
    }
  }
  if (quote || escaped)
    throw new Error("The template contains unfinished shell quoting.");
  if (names.size > 20) throw new Error("Use at most 20 parameters.");
  return [...names];
}
export function renderRunbook(
  template: string,
  values: Record<string, string>,
) {
  const names = runbookParameters(template);
  if (
    names.some((name) => typeof values[name] !== "string") ||
    Object.keys(values).some((name) => !names.includes(name))
  )
    throw new Error("Supply exactly the template's parameters.");
  const command = template.replace(
    /\{\{([A-Za-z][A-Za-z0-9_]{0,31})\}\}/g,
    (_, name: string) => {
      const value = values[name];
      if (value.length > 1000 || /[\0\r\n]/.test(value))
        throw new Error(
          "Parameter values must be single lines of at most 1000 characters.",
        );
      return "'" + value.replaceAll("'", "'\\''") + "'";
    },
  );
  if (command.length > 8192) throw new Error("Rendered command is too long.");
  return command;
}
