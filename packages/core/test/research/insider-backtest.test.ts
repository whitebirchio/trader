import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BREAKDOWNS,
  type DailyBar,
  type DataSet,
  type EventOutcome,
  type InsiderEvent,
  type InsiderPurchase,
  breakdown,
  bucketStats,
  classifyRoutine,
  eventOutcome,
  groupEvents,
  parseSecDate,
  parseTsv,
  purchasesFrom,
} from "../../src/research/insider-backtest.js";

// Real rows cut from SEC's 2025q4 Insider Transactions Data Set (columns trimmed).
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const table = (name: string) => parseTsv(readFileSync(join(fixtures, name), "utf8"));
const data: DataSet = { submissions: table("SUBMISSION.tsv"), owners: table("REPORTINGOWNER.tsv"), transactions: table("NONDERIV_TRANS.tsv") };

describe("parseSecDate", () => {
  it("reads SEC's DD-MON-YYYY dates", () => {
    expect(parseSecDate("31-OCT-2025")).toBe("2025-10-31");
    expect(parseSecDate("05-jan-2019")).toBe("2019-01-05");
    expect(parseSecDate("")).toBeNull();
    expect(parseSecDate("2025-10-31")).toBeNull();
  });
});

describe("purchasesFrom", () => {
  const purchases = purchasesFrom(data);
  const by = (ticker: string) => purchases.filter((p) => p.ticker === ticker);

  it("keeps open-market buys on original Form 4s, leaving out 10b5-1 plan buys and amendments", () => {
    expect(purchases.map((p) => p.ticker).sort()).toEqual(["ASST", "ASST", "EML", "SSKN"]);
    expect(by("CHCO")).toEqual([]); // flagged 10b5-1
    expect(by("MUNEX")).toEqual([]); // a 4/A
  });

  it("sums a filing's purchases and flags a CEO", () => {
    const ceo = by("ASST").find((p) => p.filedOn === "2025-12-16")!;
    // 11920 × 0.80 + 58739.19 × 0.81 + 237079 × 0.80 + 207457 × 0.82
    expect(ceo.dollars).toBeCloseTo(416_892.68, 2);
    expect(ceo).toMatchObject({ tradedOn: "2025-12-15", director: true, officer: true, ceoOrCfo: true, buyerName: "Cole Matthew Ryan" });
  });

  it("counts a joint filing as one buyer with every owner's roles", () => {
    expect(by("EML")).toEqual([expect.objectContaining({ buyer: "0001107149", director: true, officer: false, tenPercentOwner: true, dollars: 2433 * 20.14 })]);
  });

  it("ignores the sales in a filing that also buys", () => {
    expect(by("SSKN")[0]!.dollars).toBeCloseTo(2168 * 1.4 + 2832 * 1.41, 6);
    expect(by("SSKN")[0]!.tradedOn).toBe("2025-11-18");
  });

  it("keeps buys from quarters before the 10b5-1 flag existed (the column is missing)", () => {
    const old = { ...data, submissions: data.submissions.map(({ AFF10B5ONE: _, ...rest }) => rest) };
    expect(purchasesFrom(old).map((p) => p.ticker)).toContain("CHCO");
  });
});

describe("groupEvents", () => {
  it("groups an issuer's buys filed within the window, counting distinct buyers", () => {
    const events = groupEvents(purchasesFrom(data));
    // The two ASST buys were filed 39 days apart: two events at the default 30 days.
    expect(events.map((e) => [e.ticker, e.firstFiled, e.buyers])).toEqual([
      ["ASST", "2025-11-07", 1],
      ["SSKN", "2025-11-18", 1],
      ["ASST", "2025-12-16", 1],
      ["EML", "2025-12-16", 1],
    ]);
    const asst = groupEvents(purchasesFrom(data), 45).find((e) => e.ticker === "ASST")!;
    expect(asst).toMatchObject({ firstFiled: "2025-11-07", lastFiled: "2025-12-16", buyers: 2, ceoOrCfo: true, insider: true });
    expect(asst.dollars).toBeCloseTo(1_250_000 + 416_892.68, 2);
  });

  it("marks an event bought only by 10% owners", () => {
    const [tenOnly] = groupEvents(purchasesFrom(data)).filter((e) => e.ticker === "ASST");
    expect(tenOnly).toMatchObject({ insider: false, ceoOrCfo: false });
  });
});

describe("classifyRoutine", () => {
  const buy = (buyer: string, filedOn: string): InsiderPurchase => ({
    accession: `${buyer}-${filedOn}`, issuerCik: "9", ticker: "SPG", filedOn, tradedOn: filedOn, buyer, buyerName: buyer,
    director: true, officer: false, tenPercentOwner: false, ceoOrCfo: false, dollars: 10_000, routine: null,
  });
  const history = [buy("a", "2023-10-01"), buy("a", "2024-10-02"), buy("a", "2025-10-01"), buy("b", "2024-10-02"), buy("b", "2025-10-01"), buy("c", "2025-10-01")];

  it("marks a buyer who bought in the same month in each of the two prior years as routine", () => {
    const routine = Object.fromEntries(classifyRoutine(history, "2023-01-03").map((p) => [p.accession, p.routine]));
    expect(routine["a-2025-10-01"]).toBe(true); // October 2023, 2024 and 2025
    expect(routine["b-2025-10-01"]).toBe(false); // only October 2024 before
    expect(routine["c-2025-10-01"]).toBe(false);
  });

  it("leaves a purchase unclassified when the data doesn't reach two years back", () => {
    const routine = Object.fromEntries(classifyRoutine(history, "2023-01-03").map((p) => [p.accession, p.routine]));
    expect(routine["a-2024-10-02"]).toBeNull(); // would need October 2022
    expect(classifyRoutine(history, "2024-01-02").every((p) => p.routine === null || p.filedOn >= "2026")).toBe(true);
  });

  it("makes an event opportunistic if any buy was, and routine only if all were", () => {
    const classified = classifyRoutine(history, "2023-01-03").filter((p) => p.filedOn === "2025-10-01");
    expect(groupEvents(classified)[0]!.opportunistic).toBe(true);
    expect(groupEvents(classified.filter((p) => p.buyer === "a"))[0]!.opportunistic).toBe(false);
    expect(groupEvents([buy("z", "2025-10-01")])[0]!.opportunistic).toBeNull();
  });
});

// Synthetic daily bars: one per calendar day from 2025-09-01 (index = trading day).
const START = Date.parse("2025-09-01T00:00:00Z");
const dateAt = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);
const series = (n: number, close: number, volume = 2_000_000): DailyBar[] => Array.from({ length: n }, (_, i) => ({ date: dateAt(i), close, volume }));
const event = (lastFiled: string, over: Partial<InsiderEvent> = {}): InsiderEvent => ({
  issuerCik: "1", ticker: "XYZ", firstFiled: lastFiled, lastFiled, buyers: 2, ceoOrCfo: false, insider: true, opportunistic: true, dollars: 500_000, purchases: [], ...over,
});
const TRADABLE = { minPrice: 5, minAvgDollarVolume: 10_000_000, avgDollarVolumeDays: 20 };

describe("eventOutcome", () => {
  const filed = 100; // bars[100] is the filing date; entry is bars[101]
  const stock = series(300, 10);
  const vti = series(300, 100);
  stock[filed + 1 - 61]!.close = 13; // 60 trading days before entry: 13 → 10 is −23%
  stock[filed + 1 + 20]!.close = 12; // +20%
  vti[filed + 1 + 20]!.close = 105; // VTI +5%

  it("enters at the first close after the filing date and measures against VTI over the same days", () => {
    const o = eventOutcome(event(dateAt(filed)), stock, vti, TRADABLE) as EventOutcome;
    expect(o.entryDate).toBe(dateAt(filed + 1));
    expect(o.ret[20]).toBeCloseTo(0.2, 10);
    expect(o.excess[20]).toBeCloseTo(0.15, 10);
    expect(o.excess[60]).toBeCloseTo(0, 10);
    expect(o.prior60).toBeCloseTo(10 / 13 - 1, 10);
  });

  it("has no figure for a horizon whose window isn't complete", () => {
    const o = eventOutcome(event(dateAt(filed)), stock.slice(0, filed + 1 + 100), vti, TRADABLE) as EventOutcome;
    expect(o.excess[60]).not.toBeNull();
    expect(o.excess[120]).toBeNull();
  });

  it("skips what risk wouldn't let Trader buy at entry, and what has no bars", () => {
    expect(eventOutcome(event(dateAt(filed)), series(300, 4.99, 10_000_000), vti, TRADABLE)).toMatchObject({ skip: "untradable" });
    expect(eventOutcome(event(dateAt(filed)), series(300, 10, 999_999), vti, TRADABLE)).toMatchObject({ skip: "untradable" });
    expect(eventOutcome(event(dateAt(5)), stock, vti, TRADABLE)).toMatchObject({ skip: "untradable" }); // under 20 days of volume history
    expect(eventOutcome(event(dateAt(filed)), [], vti, TRADABLE)).toMatchObject({ skip: "no bars" });
    expect(eventOutcome(event(dateAt(400)), stock, vti, TRADABLE)).toMatchObject({ skip: "no entry" });
  });
});

describe("bucketStats and breakdowns", () => {
  const outcome = (excess20: number | null, over: Partial<EventOutcome> = {}, ev: Partial<InsiderEvent> = {}): EventOutcome => ({
    event: event("2025-12-01", ev), entryDate: "2025-12-02", entryClose: 10, prior60: -0.3, ret: { 20: excess20, 60: null, 120: null }, excess: { 20: excess20, 60: null, 120: null }, ...over,
  });

  it("summarises excess returns over the rows with a complete window", () => {
    const s = bucketStats([outcome(0.1), outcome(-0.05), outcome(0.2), outcome(null)], 20);
    expect(s.n).toBe(3);
    expect(s.mean).toBeCloseTo(0.25 / 3, 10);
    expect(s.median).toBeCloseTo(0.1, 10);
    expect(s.beatShare).toBeCloseTo(2 / 3, 10);
    // Sample sd of [0.1, −0.05, 0.2] is √(0.031667 / 2); its standard error divides by √3.
    expect(s.stdError).toBeCloseTo(Math.sqrt(0.0316666667 / 2) / Math.sqrt(3), 6);
    expect(bucketStats([], 20)).toEqual({ n: 0, mean: null, median: null, stdError: null, beatShare: null });
  });

  it("labels each outcome for the report's breakdowns", () => {
    const rows = [
      outcome(0.1, {}, { buyers: 3, ceoOrCfo: true, dollars: 2_000_000 }),
      outcome(0.1, { prior60: -0.1 }, { buyers: 1, dollars: 50_000 }),
      outcome(0.1, { prior60: null }, { buyers: 2, insider: false, dollars: 300_000 }),
    ];
    const keys = (name: string) => [...breakdown(rows, BREAKDOWNS[name]!)].map(([k, v]) => [k, v.length]);
    expect(keys("Distinct buyers")).toEqual([["1", 1], ["2", 1], ["3+", 1]]);
    expect(keys("Who bought")).toEqual([["10% owners only", 1], ["CEO or CFO", 1], ["Other officers/directors", 1]]);
    expect(keys("Dollars bought")).toEqual([["$100k–$1M", 1], ["$1M+", 1], ["Under $100k", 1]]);
    expect(keys("Prior 60 trading days")).toEqual([["Down 20%+ (dip)", 1], ["Not a dip", 1]]);
    expect(keys("Like the live strategy")).toEqual([["2+ insiders after a 20%+ drop", 1], ["Everything else", 2]]);
  });
});
