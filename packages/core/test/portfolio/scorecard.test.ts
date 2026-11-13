import { beforeEach, describe, expect, it } from "vitest";
import type { Activity } from "../../src/broker/port.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, brokerActivities, positions, strategies } from "../../src/db/schema.js";
import {
  type ScorecardThesisEvent,
  type ScorecardVersion,
  loadScorecard,
  primaryKind,
  rollUp,
  rollUps,
  scoreTheses,
  thesisWindows,
} from "../../src/portfolio/scorecard.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "./fixtures.js";

const at = (iso: string) => new Date(iso);
let seq = 0;
const activity = (o: Partial<Activity> & Pick<Activity, "type" | "at">): Activity => ({
  id: `a${String(++seq).padStart(4, "0")}`,
  symbol: null,
  side: null,
  qty: null,
  price: null,
  netAmount: null,
  orderId: null,
  raw: {},
  ...o,
});
const buy = (symbol: string, qty: string, price: string, iso: string) => activity({ type: "FILL", at: at(iso), symbol, side: "buy", qty, price });
const sell = (symbol: string, qty: string, price: string, iso: string) => activity({ type: "FILL", at: at(iso), symbol, side: "sell", qty, price });
const dividend = (symbol: string, amount: string, iso: string) => activity({ type: "DIV", at: at(iso), symbol, netAmount: amount });
const version = (n: number, iso: string, ...theses: ReturnType<typeof thesis>[]): ScorecardVersion => ({
  version: n,
  createdAt: at(iso),
  document: strategy({ conviction: theses }),
});
const event = (thesisId: string, kind: "stopped" | "stale", iso: string): ScorecardThesisEvent => ({ thesisId, kind, at: at(iso) });

const A = thesis({ id: "aapl-a", symbol: "AAPL" });
const B = thesis({ id: "aapl-b", symbol: "AAPL" });

describe("thesisWindows", () => {
  it("opens at the thesis's first buy and stays open while it's listed", () => {
    const fills = [buy("AAPL", "2", "100", "2026-11-02T14:45:00Z"), buy("AAPL", "1", "110", "2026-11-03T14:45:00Z"), sell("AAPL", "1", "120", "2026-11-04T14:45:00Z")];
    const [w, ...rest] = thesisWindows([version(1, "2026-11-02T13:00:00Z", A)], [], fills);
    expect(rest).toEqual([]);
    expect(w).toMatchObject({ ids: ["aapl-a"], symbol: "AAPL", openedAt: at("2026-11-02T14:45:00Z"), leftAt: null, closedAt: null, ending: "open", unscored: null });
    expect(w!.fills).toHaveLength(3);
  });

  it("keeps the sell-out after a version removes it, then ignores later fills of the symbol", () => {
    const windows = thesisWindows(
      [version(1, "2026-11-02T13:00:00Z", A), version(2, "2026-11-03T13:00:00Z")],
      [],
      [buy("AAPL", "2", "100", "2026-11-02T14:45:00Z"), sell("AAPL", "2", "90", "2026-11-03T14:45:00Z"), buy("AAPL", "1", "95", "2026-11-04T14:45:00Z")],
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ ending: "removed", leftAt: at("2026-11-03T13:00:00Z"), closedAt: at("2026-11-03T14:45:00Z") });
    expect(windows[0]!.fills).toHaveLength(2);
  });

  it("ends a stopped thesis at its event, and a later version still listing the id doesn't reclaim it", () => {
    const [w] = thesisWindows(
      [version(1, "2026-11-02T13:00:00Z", A), version(2, "2026-11-04T13:00:00Z", A)],
      [event("aapl-a", "stopped", "2026-11-03T21:00:00Z")],
      [buy("AAPL", "1", "100", "2026-11-02T14:45:00Z"), sell("AAPL", "1", "80", "2026-11-04T14:45:00Z"), buy("AAPL", "1", "81", "2026-11-05T14:45:00Z")],
    );
    expect(w).toMatchObject({ ending: "stopped", leftAt: at("2026-11-03T21:00:00Z"), closedAt: at("2026-11-04T14:45:00Z") });
    expect(w!.fills).toHaveLength(2);
  });

  it("ends a stale thesis at its event, unless a later version reaffirms it while held", () => {
    const fills = [buy("AAPL", "1", "100", "2026-10-01T14:45:00Z")];
    const stale = [event("aapl-a", "stale", "2026-10-31T14:00:00Z")];
    const [unwinding] = thesisWindows([version(1, "2026-10-01T13:00:00Z", A)], stale, [...fills, sell("AAPL", "1", "105", "2026-10-31T14:45:00Z")]);
    expect(unwinding).toMatchObject({ ending: "stale", closedAt: at("2026-10-31T14:45:00Z") });

    const [reaffirmed] = thesisWindows([version(1, "2026-10-01T13:00:00Z", A), version(2, "2026-10-31T14:05:00Z", A)], stale, fills);
    expect(reaffirmed).toMatchObject({ ending: "open", leftAt: null, closedAt: null });
  });

  it("ends an overdue thesis at its event, like a stale one", () => {
    const [w] = thesisWindows(
      [version(1, "2026-11-02T13:00:00Z", A)],
      [{ thesisId: "aapl-a", kind: "overdue", at: at("2026-12-02T15:00:00Z") }],
      [buy("AAPL", "1", "100", "2026-11-02T14:45:00Z"), sell("AAPL", "1", "110", "2026-12-02T15:45:00Z")],
    );
    expect(w).toMatchObject({ ending: "overdue", leftAt: at("2026-12-02T15:00:00Z"), closedAt: at("2026-12-02T15:45:00Z") });
  });

  it("continues the row when a new id takes over shares still held", () => {
    const windows = thesisWindows(
      [version(1, "2026-11-02T13:00:00Z", A), version(2, "2026-11-03T13:00:00Z", B)],
      [],
      [buy("AAPL", "1", "100", "2026-11-02T14:45:00Z"), buy("AAPL", "1", "110", "2026-11-03T14:45:00Z")],
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ ids: ["aapl-a", "aapl-b"], ending: "open" });
    expect(windows[0]!.fills).toHaveLength(2);
  });

  it("starts a new row when the new id arrives after the position went flat", () => {
    const windows = thesisWindows(
      [version(1, "2026-11-02T13:00:00Z", A), version(2, "2026-11-03T13:00:00Z"), version(3, "2026-11-05T13:00:00Z", B)],
      [],
      [buy("AAPL", "1", "100", "2026-11-02T14:45:00Z"), sell("AAPL", "1", "90", "2026-11-03T14:45:00Z"), buy("AAPL", "1", "95", "2026-11-05T14:45:00Z")],
    );
    expect(windows.map((w) => [w.ids, w.ending])).toEqual([[["aapl-a"], "removed"], [["aapl-b"], "open"]]);
  });

  it("marks a thesis on a symbol already held as unscored, and ignores fills no thesis claims", () => {
    const vti = thesis({ id: "vti-x", symbol: "VTI" });
    const windows = thesisWindows(
      [version(1, "2026-11-03T13:00:00Z", vti)],
      [],
      [buy("VTI", "1", "300", "2026-11-02T14:45:00Z"), buy("MSFT", "1", "400", "2026-11-03T14:45:00Z")],
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ symbol: "VTI", openedAt: at("2026-11-03T13:00:00Z"), unscored: "the symbol was already held when the thesis started" });
  });

  it("reads old documents leniently and skips a version with no conviction list", () => {
    const old: ScorecardVersion = {
      version: 1,
      createdAt: at("2026-11-02T13:00:00Z"),
      // Fails today's schema (number weight, no stop-loss), but still names a thesis.
      document: { summary: "old", conviction: [{ id: "aapl-a", symbol: "AAPL", targetWeightPct: 5, evidence: [{ kind: "insider" }] }, { note: "junk" }] },
    };
    const broken: ScorecardVersion = { version: 2, createdAt: at("2026-11-03T13:00:00Z"), document: { summary: "no list" } };
    const [w] = thesisWindows([old, broken], [], [buy("AAPL", "1", "100", "2026-11-02T14:45:00Z")]);
    expect(w).toMatchObject({ ids: ["aapl-a"], kinds: ["insider"], ending: "open" });
  });

  it("marks a symbol with a lot issue (a split) as unscored", () => {
    const [w] = thesisWindows(
      [version(1, "2026-11-02T13:00:00Z", A)],
      [],
      [buy("AAPL", "1", "100", "2026-11-02T14:45:00Z"), activity({ type: "SSP", at: at("2026-11-04T12:00:00Z"), symbol: "AAPL" })],
    );
    expect(w!.unscored).toBe("unsupported share-affecting activity SSP");
  });
});

const closes = [
  { tradingDate: "2026-11-02", close: "250" },
  { tradingDate: "2026-11-03", close: "300" },
  { tradingDate: "2026-11-04", close: "200" },
];
const asOf = at("2026-11-06T21:00:00Z");

describe("scoreTheses", () => {
  it("compares an open thesis with the same dollars bought in VTI that day", () => {
    const fills = [buy("AAPL", "2", "100", "2026-11-02T14:45:00Z")];
    const windows = thesisWindows([version(1, "2026-11-02T13:00:00Z", A)], [], fills);
    // $200 → 0.8 VTI at $250. AAPL 2 × $120 = $240 (+40); VTI 0.8 × $275 = $220 (+20).
    const [row] = scoreTheses(windows, { activities: fills, marks: { AAPL: "120" }, vtiCloses: closes, vtiMark: "275", asOf });
    expect(row).toMatchObject({ qty: "2", daysHeld: 4, unscored: null, primaryKind: "fundamental" });
    expect(row!.money).toEqual({
      bought: "200", proceeds: "0", dividends: "0", marketValue: "240", pnl: "40", vtiPnl: "20", excess: "20", returnPct: "20", vtiPct: "10", excessPct: "10",
    });
  });

  it("sells the same fraction of the VTI shadow as each partial sell", () => {
    const fills = [buy("AAPL", "2", "100", "2026-11-02T14:45:00Z"), sell("AAPL", "1", "130", "2026-11-03T14:45:00Z")];
    const windows = thesisWindows([version(1, "2026-11-02T13:00:00Z", A)], [], fills);
    // Thesis: 130 + 110 − 200 = +40. Shadow: 0.8 sh; half (0.4) sold at $300 = 120, 0.4 × $275 = 110 → +30.
    const [row] = scoreTheses(windows, { activities: fills, marks: { AAPL: "110" }, vtiCloses: closes, vtiMark: "275", asOf });
    expect(row!.money).toMatchObject({ pnl: "40", vtiPnl: "30", excess: "10", returnPct: "20", vtiPct: "15", excessPct: "5" });
  });

  it("counts dividends inside a closed window, not after it, and can beat VTI while losing money", () => {
    const acts = [
      buy("AAPL", "1", "100", "2026-11-02T14:45:00Z"),
      dividend("AAPL", "1.50", "2026-11-03T12:00:00Z"),
      sell("AAPL", "1", "90", "2026-11-04T14:45:00Z"),
      dividend("AAPL", "1.50", "2026-11-05T12:00:00Z"),
    ];
    const windows = thesisWindows([version(1, "2026-11-02T13:00:00Z", A), version(2, "2026-11-03T13:00:00Z")], [], acts);
    // Thesis: 90 + 1.50 − 100 = −8.50. Shadow: 0.4 sh sold at $200 = 80 → −20.
    const [row] = scoreTheses(windows, { activities: acts, marks: {}, vtiCloses: closes, asOf });
    expect(row).toMatchObject({ ending: "removed", qty: "0", daysHeld: 2 });
    expect(row!.money).toMatchObject({ dividends: "1.5", marketValue: "0", pnl: "-8.5", vtiPnl: "-20", excess: "11.5", excessPct: "11.5" });
  });

  it("leaves a row unscored without a current price, and keeps an unscored window's reason", () => {
    const fills = [buy("AAPL", "1", "100", "2026-11-02T14:45:00Z")];
    const [noMark] = scoreTheses(thesisWindows([version(1, "2026-11-02T13:00:00Z", A)], [], fills), { activities: fills, marks: {}, vtiCloses: closes, asOf });
    expect(noMark).toMatchObject({ unscored: "no current price for AAPL", money: null });

    const early = [buy("AAPL", "1", "100", "2026-11-01T14:45:00Z")];
    const [noClose] = scoreTheses(thesisWindows([version(1, "2026-11-01T13:00:00Z", A)], [], early), { activities: early, marks: { AAPL: "1" }, vtiCloses: closes, asOf });
    expect(noClose).toMatchObject({ unscored: "no VTI close on or before 2026-11-01", money: null });
  });
});

describe("primaryKind", () => {
  it("is the most frequent kind, ties to the earliest listed", () => {
    expect(primaryKind(["insider", "fundamental", "insider", "news"])).toBe("insider");
    expect(primaryKind(["fundamental", "insider"])).toBe("fundamental");
    expect(primaryKind([])).toBeNull();
  });
});

describe("rollUp", () => {
  const acts = [
    buy("AAPL", "2", "100", "2026-11-02T14:45:00Z"),
    buy("MSFT", "1", "100", "2026-11-02T14:45:00Z"),
    buy("NVDA", "1", "100", "2026-11-02T14:45:00Z"),
    sell("MSFT", "1", "90", "2026-11-04T14:45:00Z"),
  ];
  const msft = thesis({ id: "msft-a", symbol: "MSFT", evidence: [{ kind: "insider", summary: "CEO bought" }] });
  const nvda = thesis({ id: "nvda-a", symbol: "NVDA", evidence: [{ kind: "insider", summary: "CFO bought" }] });
  const windows = thesisWindows([version(1, "2026-11-02T13:00:00Z", A, msft, nvda), version(2, "2026-11-03T13:00:00Z", A, nvda)], [], acts);
  // NVDA has no mark, so it's unscored.
  const rows = scoreTheses(windows, { activities: acts, marks: { AAPL: "120" }, vtiCloses: closes, vtiMark: "275", asOf });

  it("sums scored rows and counts unscored ones", () => {
    // AAPL +40 vs +20; MSFT −10 vs (0.4 × 200 − 100) = −20.
    expect(rollUp(rows)).toEqual({
      theses: 3, scored: 2, closed: 1, bought: "300", pnl: "30", vtiPnl: "0", excess: "30", excessPct: "10", beatVtiPct: "100", medianDaysHeld: 3,
    });
  });

  it("groups by primary kind, most bought first", () => {
    const { overall, byKind } = rollUps(rows);
    expect(overall.theses).toBe(3);
    expect(byKind.map((k) => [k.kind, k.theses, k.bought])).toEqual([["fundamental", 1, "200"], ["insider", 2, "100"]]);
  });

  it("rolls up by a declared lead signal over the evidence, and says which rows are inferred (forecast ledger)", () => {
    // Inferred, the tie goes to the first-listed fundamental item; declared, it's insider-led.
    const evidence = [{ kind: "fundamental" as const, summary: "Margins recovering" }, { kind: "insider" as const, summary: "CEO bought" }];
    const led = thesis({ id: "msft-b", symbol: "MSFT", evidence, leadSignal: "insider" });
    const [declared] = scoreTheses(thesisWindows([version(1, "2026-11-02T13:00:00Z", led)], [], [buy("MSFT", "1", "100", "2026-11-02T14:45:00Z")]), { activities: [], marks: {}, vtiCloses: closes, vtiMark: "275", asOf });
    expect(declared).toMatchObject({ primaryKind: "insider", kindSource: "declared" });
    expect(rows.find((r) => r.symbol === "MSFT")).toMatchObject({ primaryKind: "insider", kindSource: "inferred" });
  });

  it("has nulls for an empty group", () => {
    expect(rollUp([])).toMatchObject({ theses: 0, bought: "0", excessPct: null, beatVtiPct: null, medianDaysHeld: null });
  });
});

describe("loadScorecard", () => {
  // In a hook (10s timeout), like every other database test: the file's first
  // createTestDb also migrates the template, which can take seconds on CI.
  let db: Db;
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it("scores the stored history, newest first, from the database alone", async () => {
    const msft = thesis({ id: "msft-a", symbol: "MSFT", evidence: [{ kind: "insider", summary: "CEO bought" }] });
    await db.insert(strategies).values([
      { authoredBy: "claude", createdAt: at("2026-11-02T13:00:00Z"), summary: "v1", document: strategy({ conviction: [A] }) as unknown as Record<string, unknown> },
      { authoredBy: "claude", createdAt: at("2026-11-03T13:00:00Z"), summary: "v2", document: strategy({ conviction: [A, msft] }) as unknown as Record<string, unknown> },
    ]);
    await db.insert(brokerActivities).values([
      { id: "f1", type: "FILL", at: at("2026-11-02T14:45:00Z"), symbol: "AAPL", side: "buy", qty: "2", price: "100", raw: {} },
      { id: "f2", type: "FILL", at: at("2026-11-03T14:45:00Z"), symbol: "MSFT", side: "buy", qty: "1", price: "300", raw: {} },
      { id: "f3", type: "FILL", at: at("2026-11-02T14:50:00Z"), symbol: "VTI", side: "buy", qty: "1", price: "250", raw: {} },
    ]);
    const syncedAt = at("2026-11-06T21:15:00Z");
    await db.insert(positions).values([
      { symbol: "AAPL", qty: "2", avgEntryPrice: "100", marketValue: "240", costBasis: "200", currentPrice: "120", syncedAt },
      { symbol: "MSFT", qty: "1", avgEntryPrice: "300", marketValue: "270", costBasis: "300", currentPrice: "270", syncedAt },
      { symbol: "VTI", qty: "1", avgEntryPrice: "250", marketValue: "275", costBasis: "250", currentPrice: "275", syncedAt },
    ]);
    await db.insert(benchmarkCloses).values(closes.map((c) => ({ symbol: "VTI", ...c })));

    const card = await loadScorecard(db, asOf);
    expect(card.markedAt).toEqual(syncedAt);
    expect(card.theses.map((r) => [r.ids[0], r.primaryKind, r.money?.pnl, r.money?.vtiPnl])).toEqual([
      // $300 → 1 VTI at $300, now $275.
      ["msft-a", "insider", "-30", "-25"],
      ["aapl-a", "fundamental", "40", "20"],
    ]);
    expect(card.overall).toMatchObject({ theses: 2, scored: 2, bought: "500", excess: "15", excessPct: "3", beatVtiPct: "50" });
    expect(card.byKind.map((k) => k.kind)).toEqual(["insider", "fundamental"]);
  });
});
