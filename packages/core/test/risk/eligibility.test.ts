import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import { assetFacts, ineligibleReasons } from "../../src/risk/eligibility.js";
import { LIMITS } from "../../src/risk/limits.js";
import type { AssetFacts } from "../../src/risk/types.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "broker", "fixtures");
// Real Alpaca asset records, captured 2026-10-31 (npm run broker:capture -- assets).
const recorded = JSON.parse(readFileSync(join(fixtures, "assets.json"), "utf8")) as {
  symbol: string;
  name: string;
  margin_requirement_long: string;
  tradable: boolean;
  fractionable: boolean;
}[];

/** Facts for a recorded asset with healthy price, volume and history. */
function healthy(symbol: string): AssetFacts {
  const a = recorded.find((r) => r.symbol === symbol);
  if (!a) throw new Error(`no fixture for ${symbol}`);
  return {
    symbol,
    name: a.name,
    tradable: a.tradable,
    fractionable: a.fractionable,
    marginRequirementLong: a.margin_requirement_long,
    lastClose: "100",
    avgDollarVolume: "500000000",
    historyDays: 3000,
  };
}

describe("leveraged and inverse funds (recorded assets)", () => {
  it.each(["VTI", "QQQ", "AAPL", "XLK", "ARKK", "VGSH", "SGOV", "BIL", "SHV"])("%s is eligible", (symbol) => {
    expect(ineligibleReasons(symbol, healthy(symbol), LIMITS)).toEqual([]);
  });

  it.each([
    ["TQQQ", "margin requirement 75%"],
    ["SQQQ", "margin requirement 75%"],
    ["SPXL", "margin requirement 100%"],
    ["UVXY", "margin requirement 100%"],
    ["SOXL", "margin requirement 75%"],
    ["SH", 'by name ("ProShares Short S&P500")'], // 1× inverse: normal margin, caught by name
    ["TBF", 'by name ("ProShares Short 20+ Year Treasury ETF")'], // inverse Treasuries: normal margin, caught by name
  ])("%s is rejected (%s)", (symbol, why) => {
    const reasons = ineligibleReasons(symbol, healthy(symbol), LIMITS);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(why);
    expect(reasons[0]).toContain("leveraged or inverse");
  });
});

describe("other eligibility rules", () => {
  const vti = healthy("VTI");

  it("rejects penny stocks", () => {
    expect(ineligibleReasons("XYZ", { ...vti, symbol: "XYZ", lastClose: "4.99" }, LIMITS)).toEqual([
      "XYZ trades under $5 ($4.99).",
    ]);
  });

  it("rejects illiquid names", () => {
    expect(ineligibleReasons("XYZ", { ...vti, avgDollarVolume: "9999999" }, LIMITS)[0]).toMatch(/illiquid/);
  });

  it("rejects recent IPOs", () => {
    expect(ineligibleReasons("NEWCO", { ...vti, historyDays: 45 }, LIMITS)).toEqual([
      "NEWCO has only 45 days of trading history (minimum 90).",
    ]);
  });

  it("rejects non-fractionable and untradable assets", () => {
    expect(ineligibleReasons("BRK.A", { ...vti, fractionable: false, tradable: false }, LIMITS)).toEqual([
      "BRK.A isn't tradable at Alpaca.",
      "BRK.A can't be traded in fractional shares.",
    ]);
  });

  it("fails closed on missing facts", () => {
    expect(ineligibleReasons("VTI", undefined, LIMITS)).toEqual(["Couldn't verify VTI's eligibility (no asset data)."]);
    const unknown = ineligibleReasons("VTI", { ...vti, marginRequirementLong: null, lastClose: null, avgDollarVolume: null, historyDays: null }, LIMITS);
    expect(unknown).toHaveLength(4);
    expect(unknown.every((r) => r.startsWith("Couldn't verify"))).toBe(true);
  });
});

describe("assetFacts", () => {
  const now = new Date("2026-11-02T15:00:00Z");
  const bar = (daysAgo: number, c: string, v: string): Bar => ({
    t: new Date(now.getTime() - daysAgo * 86_400_000),
    o: c,
    h: c,
    l: c,
    c,
    v,
  });
  const asset = { symbol: "VTI", name: "Vanguard Total Stock Market ETF", status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" };

  it("derives last close, average dollar volume over the last 20 bars, and history length", () => {
    const bars = [bar(119, "1", "999999999"), ...Array.from({ length: 20 }, (_, i) => bar(20 - i, "300", "100000"))];
    expect(assetFacts("VTI", asset, bars, now, LIMITS)).toMatchObject({
      lastClose: "300",
      avgDollarVolume: "30000000",
      historyDays: 119,
      marginRequirementLong: "30",
    });
  });

  it("returns undefined for an unknown asset and nulls for missing bars", () => {
    expect(assetFacts("NOPE", null, [], now, LIMITS)).toBeUndefined();
    expect(assetFacts("VTI", asset, [], now, LIMITS)).toMatchObject({ lastClose: null, avgDollarVolume: null, historyDays: null });
  });

  it("treats an inactive asset as untradable", () => {
    expect(assetFacts("VTI", { ...asset, status: "inactive" }, [bar(1, "300", "1")], now, LIMITS)?.tradable).toBe(false);
  });
});
