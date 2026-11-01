import { describe, expect, it } from "vitest";
import { compareToBenchmark } from "../../src/portfolio/benchmark.js";
import { marketDate } from "../../src/time.js";

const bar = (date: string, c: string) => ({ t: new Date(`${date}T05:00:00Z`), c });

describe("compareToBenchmark", () => {
  it("compares the flow-adjusted index with VTI over the same days", () => {
    const points = [
      { tradingDate: "2026-11-02", index: "1" },
      { tradingDate: "2026-11-03", index: "1.0124" },
    ];
    const vti = [bar("2026-10-30", "295"), bar("2026-11-02", "300"), bar("2026-11-03", "302.4")];
    expect(compareToBenchmark(points, vti, marketDate)).toEqual({ since: "2026-11-02", through: "2026-11-03", portfolioPct: "1.24", benchmarkPct: "0.8" });
  });

  it("uses the last VTI close on or before a snapshot date (e.g. a holiday)", () => {
    const points = [
      { tradingDate: "2026-11-02", index: "1" },
      { tradingDate: "2026-11-05", index: "0.99" },
    ];
    expect(compareToBenchmark(points, [bar("2026-11-02", "300"), bar("2026-11-04", "297")], marketDate)?.benchmarkPct).toBe("-1");
  });

  it("is null with fewer than two snapshots or no matching prices", () => {
    expect(compareToBenchmark([{ tradingDate: "2026-11-02", index: "1" }], [bar("2026-11-02", "300")], marketDate)).toBeNull();
    expect(compareToBenchmark([{ tradingDate: "2026-11-02", index: "1" }, { tradingDate: "2026-11-03", index: "1" }], [], marketDate)).toBeNull();
  });
});
