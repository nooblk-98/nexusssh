import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  presetLayout,
  renderRunbook,
  runbookParameters,
} from "../../packages/shared/workflows.js";
import {
  fileVersion,
  withFileLock,
} from "../../packages/shared/file-version.js";
import {
  correlationId,
  requestContext,
} from "../../packages/shared/request-context.js";

describe("runbook parameters", () => {
  it("quotes shell metacharacters as literal values and supports repeated parameters", () => {
    const value = "db'; touch /tmp/unwanted; echo '$(id)";
    expect(
      renderRunbook("printf %s {{name}} && printf %s {{name}}", {
        name: value,
      }),
    ).toBe(
      "printf %s 'db'\\''; touch /tmp/unwanted; echo '\\''$(id)' && printf %s 'db'\\''; touch /tmp/unwanted; echo '\\''$(id)'",
    );
    expect(runbookParameters("echo {{x}} {{x}} {{y}} ")).toEqual(["x", "y"]);
  });
  it.each([
    'echo "{{value}}"',
    "echo '{{value}}'",
    "cat <<EOF {{value}}",
    "echo $(echo {{value}})",
    "echo `echo {{value}}`",
    "echo \\{{value}}",
    "echo {{value}}\necho done",
    "echo {{bad name}}",
  ])("rejects unsafe quoting context: %s", (template) => {
    expect(() => renderRunbook(template, { value: "x" })).toThrow();
  });
  it("requires exact parameters, limits values and never accepts NULs", () => {
    expect(() => renderRunbook("echo {{value}}", {})).toThrow();
    expect(() =>
      renderRunbook("echo {{value}}", { value: "x", other: "y" }),
    ).toThrow();
    expect(() => renderRunbook("echo {{value}}", { value: "a\0b" })).toThrow();
    expect(() =>
      renderRunbook("echo {{value}}", { value: "a".repeat(1001) }),
    ).toThrow();
  });
});
it("presets accept layout metadata and reject session tokens and credentials", () => {
  const tab = { kind: "terminal", serverId: randomUUID(), title: "App" };
  expect(presetLayout.parse({ columns: 2, tabs: [tab] }).tabs).toHaveLength(1);
  expect(() =>
    presetLayout.parse({ columns: 2, tabs: [{ ...tab, resume: "secret" }] }),
  ).toThrow();
  expect(() =>
    presetLayout.parse({
      columns: 2,
      tabs: [{ ...tab, privateKey: "secret" }],
    }),
  ).toThrow();
  expect(() => presetLayout.parse({ columns: 5, tabs: [] })).toThrow();
});
it("serializes concurrent editor saves and releases the lock after failures", async () => {
  let contents = Buffer.from("original");
  const expected = fileVersion(contents),
    key = randomUUID();
  const save = (value: string) =>
    withFileLock(key, async () => {
      if (fileVersion(contents) !== expected) throw new Error("conflict");
      await new Promise((resolve) => setTimeout(resolve, 5));
      contents = Buffer.from(value);
    });
  const results = await Promise.allSettled([save("first"), save("second")]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(contents.toString()).toBe("first");
  await expect(withFileLock(key, async () => "released")).resolves.toBe(
    "released",
  );
});
it("keeps request identities separate across asynchronous operations", async () => {
  const ids = [randomUUID(), randomUUID()];
  const values = await Promise.all(
    ids.map((id) =>
      requestContext.run({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return correlationId();
      }),
    ),
  );
  expect(values).toEqual(ids);
});
