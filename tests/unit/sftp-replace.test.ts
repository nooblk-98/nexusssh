import { describe, expect, it, vi } from "vitest";
import { replaceSftpFile } from "../../apps/api/src/sftp-replace.js";

describe("SFTP replacement", () => {
  it("preserves the destination if both rename methods fail", async () => {
    const files = new Map([
      ["old", "original"],
      ["tmp", "replacement"],
    ]);
    const rename = vi.fn(async (method: string, from: string, to: string) => {
      if (method === "ext_openssh_rename") throw new Error("unsupported");
      if (files.has(to)) throw new Error("destination exists");
      files.set(to, files.get(from)!);
      files.delete(from);
    });
    await expect(replaceSftpFile("tmp", "old", rename)).rejects.toThrow(
      "destination exists",
    );
    expect(files.get("old")).toBe("original");
    expect(files.get("tmp")).toBe("replacement");
    expect(rename).toHaveBeenCalledTimes(2);
  });
});
