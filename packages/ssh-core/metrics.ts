/** Parse Linux procps output. Unsupported fields remain null rather than fabricated. */
export function parseMetrics(stdout: string) {
  const lines = stdout.split("\n"),
    cpus = lines
      .filter((l) => /^cpu\s/.test(l))
      .map((l) => l.trim().split(/\s+/).slice(1).map(Number));
  let cpuPercent: number | null = null;
  if (cpus.length >= 2) {
    const first = cpus[0].slice(0, 8),
      last = cpus[1].slice(0, 8),
      total =
        last.reduce((a, b) => a + b, 0) - first.reduce((a, b) => a + b, 0),
      idle = last[3] + last[4] - first[3] - first[4];
    if (total > 0)
      cpuPercent = Math.max(
        0,
        Math.min(100, Math.round((1 - idle / total) * 1000) / 10),
      );
  }
  const memory = lines
    .find((l) => /^Mem:/.test(l))
    ?.trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const uptime = lines[lines.findIndex((l) => l.includes("--- uptime ---")) + 1]
    ?.trim()
    .split(/\s+/);
  const load = lines[lines.findIndex((l) => l.includes("--- load ---")) + 1]
    ?.trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(Number);
  const disks = lines
    .filter((l) => /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+/.test(l))
    .map((l) => {
      const [device, total, used, available, percent, mount] = l
        .trim()
        .split(/\s+/);
      return {
        device,
        totalBytes: Number(total),
        usedBytes: Number(used),
        availableBytes: Number(available),
        usedPercent: Number(percent.replace("%", "")),
        mount,
      };
    });
  return {
    cpuPercent,
    memory: memory
      ? {
          totalBytes: memory[0],
          usedBytes: memory[1],
          availableBytes: memory[5],
          usedPercent: Math.round((memory[1] / memory[0]) * 1000) / 10,
        }
      : null,
    uptimeSeconds: uptime && /^\d/.test(uptime[0]) ? Number(uptime[0]) : null,
    loadAverage: load?.every(Number.isFinite) ? load : null,
    disks,
    collectedAt: new Date().toISOString(),
  };
}
