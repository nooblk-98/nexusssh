import { describe, expect, it } from "vitest";
import { parseMetrics } from "../../apps/api/src/terminal.js";

const output = (cpu: string, available = 600, used = 25) =>
  `cpu  ${cpu}\nMemTotal:       1000 kB\nMemAvailable:   ${available} kB\n/dev/sda1 100 ${used} 75 25% /\n`;

describe("terminal metrics parser", () => {
  it("computes the initial CPU from two samples, then uses the prior poll", () => {
    const first = parseMetrics(output("100 20 30 400 50 10 5 5 20 10\ncpu  125 30 50 440 60 10 5 5 90 80"));
    expect(first?.frame).toEqual({ type: "metrics", cpu: 52, memory: 40, storage: 25 });
    expect(first?.sample).toEqual({ idle: 500n, total: 725n });
    const second = parseMetrics(output("150 40 70 480 70 10 5 5 150 120"), first?.sample);
    expect(second?.sample).toEqual({ idle: 550n, total: 830n });
    expect(second?.frame.cpu).toBe(52);
  });

  it("rejects invalid memory and storage readings", () => {
    expect(parseMetrics(output("1 1 1 1", -1))).toBeUndefined();
    expect(parseMetrics(output("1 1 1 1", 1001))).toBeUndefined();
    expect(parseMetrics(output("1 1 1 1", 500, -1))).toBeUndefined();
    expect(parseMetrics(output("1 1 1 1", 500, 101))).toBeUndefined();
    expect(parseMetrics("bad output")).toBeUndefined();
  });

  it("keeps valid boundary percentages within zero and one hundred", () => {
    expect(parseMetrics(output("1 1 1 1", 0, 100))?.frame).toEqual({ type: "metrics", cpu: null, memory: 100, storage: 100 });
    expect(parseMetrics(output("1 1 1 1", 1000, 0))?.frame).toEqual({ type: "metrics", cpu: null, memory: 0, storage: 0 });
  });
});
