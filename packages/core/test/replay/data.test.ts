import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Asset, type Bar, BrokerHttpError, type CalendarDay } from "../../src/broker/port.js";
import { type MarketSource, loadMarket } from "../../src/replay/data.js";

const asset = (symbol: string): Asset => ({ symbol, name: symbol, status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" });

/** A fake Alpaca with bars for AAPL and VTI over a few days, counting every call. */
function source(overrides: Partial<MarketSource> = {}) {
  const calls = { bars: [] as string[][], calendar: 0, asset: [] as string[] };
  const days = ["2025-01-02", "2025-01-03", "2025-01-06"];
  const bar = (d: string, c: string): Bar => ({ t: new Date(`${d}T05:00:00Z`), o: c, h: c, l: c, c, v: "100" });
  const s: MarketSource = {
    getDailyBars: async (symbols) => {
      calls.bars.push([...symbols]);
      return Object.fromEntries(symbols.filter((x) => x !== "GONE").map((x) => [x, days.map((d, i) => bar(d, String(100 + i)))]));
    },
    getCalendar: async () => {
      calls.calendar++;
      return days.map((date): CalendarDay => ({ date, open: new Date(`${date}T14:30:00Z`), close: new Date(`${date}T21:00:00Z`) }));
    },
    getAsset: async (symbol) => {
      calls.asset.push(symbol);
      return symbol === "GONE" ? null : asset(symbol);
    },
    ...overrides,
  };
  return { s, calls };
}

const dir = () => mkdtempSync(join(tmpdir(), "replay-cache-"));
const noSleep = async () => {};

describe("loadMarket", () => {
  it("fetches once, then serves the same range from the cache without asking Alpaca again", async () => {
    const d = dir();
    const { s, calls } = source();
    const first = await loadMarket(["VTI", "AAPL"], "2025-01-02", "2025-01-06", { dir: d, source: s, sleep: noSleep });
    expect(first.market.bars.VTI!.map((b) => b.c)).toEqual(["100", "101", "102"]);
    expect(first.market.calendar.map((c) => c.date)).toEqual(["2025-01-02", "2025-01-03", "2025-01-06"]);
    expect(Object.keys(first.market.assets)).toEqual(["AAPL", "VTI"]);
    expect(calls).toEqual({ bars: [["AAPL", "VTI"]], calendar: 1, asset: ["AAPL", "VTI"] });

    const again = await loadMarket(["AAPL", "VTI"], "2025-01-02", "2025-01-06", { dir: d, source: s, sleep: noSleep });
    expect(again.market.bars).toEqual(first.market.bars);
    expect(calls).toEqual({ bars: [["AAPL", "VTI"]], calendar: 1, asset: ["AAPL", "VTI"] }); // nothing new
  });

  it("refetches a symbol (and the calendar) when the cached range doesn't cover the one asked for", async () => {
    const d = dir();
    const { s, calls } = source();
    await loadMarket(["VTI"], "2025-01-02", "2025-01-03", { dir: d, source: s, sleep: noSleep });
    await loadMarket(["VTI"], "2025-01-02", "2025-01-06", { dir: d, source: s, sleep: noSleep });
    expect(calls.bars).toEqual([["VTI"], ["VTI"]]);
    expect(calls.calendar).toBe(2);
  });

  it("reports symbols with no bars or no asset instead of dropping them silently", async () => {
    const { s } = source();
    const r = await loadMarket(["VTI", "GONE"], "2025-01-02", "2025-01-06", { dir: dir(), source: s, sleep: noSleep });
    expect(r.missing).toEqual({ bars: ["GONE"], assets: ["GONE"] });
    expect(r.market.assets.GONE).toBeUndefined();
  });

  it("caches nothing for a failed fetch, waits out a rate limit, and splits a batch one bad symbol broke", async () => {
    const d = dir();
    const failing = source({ getDailyBars: async () => { throw new Error("network down"); } });
    await expect(loadMarket(["VTI"], "2025-01-02", "2025-01-06", { dir: d, source: failing.s, sleep: noSleep })).rejects.toThrow("network down");
    expect(existsSync(join(d, "bars", "VTI.json"))).toBe(false);

    let n = 0;
    const waits: number[] = [];
    const limited = source({
      getDailyBars: async (symbols) => {
        n++;
        if (n === 1) throw new BrokerHttpError(429, null, "too many requests");
        if (symbols.length > 1) throw new BrokerHttpError(400, null, "invalid symbol: BAD");
        return symbols[0] === "BAD" ? Promise.reject(new BrokerHttpError(400, null, "invalid symbol: BAD")) : { [symbols[0]!]: [{ t: new Date("2025-01-02T05:00:00Z"), o: "1", h: "1", l: "1", c: "1", v: "1" }] };
      },
    });
    const r = await loadMarket(["VTI", "BAD"], "2025-01-02", "2025-01-06", { dir: dir(), source: limited.s, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([60_000]);
    expect(r.market.bars.VTI).toHaveLength(1);
    expect(r.missing.bars).toEqual(["BAD"]);
  });

  it("waits out a rate limit on asset records, keeping the ones already fetched", async () => {
    const d = dir();
    let n = 0;
    const waits: number[] = [];
    const limited = source({
      getAsset: async (symbol) => {
        n++;
        if (n === 2) throw new BrokerHttpError(429, null, "rate limit exceeded");
        return asset(symbol);
      },
    });
    const r = await loadMarket(["AAPL", "VTI"], "2025-01-02", "2025-01-06", { dir: d, source: limited.s, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([60_000]);
    expect(Object.keys(r.market.assets).sort()).toEqual(["AAPL", "VTI"]);
    expect(n).toBe(3); // AAPL, VTI limited, VTI again
  });
});
