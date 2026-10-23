// A failed replacement must leave the old destination intact. The OpenSSH
// extension replaces atomically; standard SFTP rename may refuse overwrites.
export async function replaceSftpFile(
  from: string,
  to: string,
  rename: (
    method: "ext_openssh_rename" | "rename",
    from: string,
    to: string,
  ) => Promise<unknown>,
) {
  try {
    await rename("ext_openssh_rename", from, to);
  } catch {
    await rename("rename", from, to);
  }
}
