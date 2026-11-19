import { beforeEach, describe, expect, it } from "vitest";
import { EVENT_RUNS, type TriggerInput, checkEvents, findTriggers, loadTriggerInput, tripSubject, watchStatus } from "../../src/agent/events.js";
import { recordEvent } from "../../src/audit.js";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, thesisCloses } from "../../src/db/schema.js";
import { routeFor } from "../../src/notifications/routing.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

// AAPL bought at $100 with a 10% stop: the stop price is $90, and near it means at or below $92.70.
const aapl = thesis({ id: "aapl-a", symbol: "AAPL", stopLossPct: "10" });
const input = (overrides: Partial<TriggerInput> = {}): TriggerInput => ({
  theses: [aapl],
  averageCost: new Map([["AAPL", "100"]]),
  price: new Map([["AAPL", "100"]]),
  previousClose: new Map(),
  sellFilings: [],
  boughtToday: new Set(),
  ...overrides,
});
const kinds = (i: TriggerInput) => findTriggers(i).map((t) => t.trigger);

describe("findTriggers", () => {
  it("trips near the stop at 3% above it, not at 3.01%", () => {
    expect(findTriggers(input({ price: new Map([["AAPL", "92.70"]]) }))).toEqual([
      { symbol: "AAPL", thesisId: "aapl-a", trigger: "near_stop", price: "92.70", reference: "90", distancePct: "3", detail: "AAPL at $92.70 is 3% above its 10% stop ($90.00)" },
    ]);
    expect(kinds(input({ price: new Map([["AAPL", "92.71"]]) }))).toEqual([]);
    expect(EVENT_RUNS.nearStopPct).toBe("3");
  });

  it("says when the price is already below the stop", () => {
    expect(findTriggers(input({ price: new Map([["AAPL", "88"]]) }))[0]!.detail).toBe("AAPL at $88.00 is 2.22% below its 10% stop ($90.00)");
  });

  it("trips on an 8% move either way from the previous close, not 7.99%", () => {
    const at = (price: string) => input({ averageCost: new Map([["AAPL", "50"]]), price: new Map([["AAPL", price]]), previousClose: new Map([["AAPL", "100"]]) });
    expect(findTriggers(at("108"))).toEqual([expect.objectContaining({ trigger: "move", distancePct: "8", detail: "AAPL rose 8% from the previous close ($100.00 → $108.00)" })]);
    expect(findTriggers(at("92"))).toEqual([expect.objectContaining({ trigger: "move", distancePct: "-8", detail: "AAPL fell 8% from the previous close ($100.00 → $92.00)" })]);
    expect(kinds(at("107.99"))).toEqual([]);
    expect(kinds(input({ averageCost: new Map([["AAPL", "50"]]), price: new Map([["AAPL", "120"]]) }))).toEqual([]); // no previous close
  });

  it("trips on a sell-signal filing for a held thesis only, once per symbol", () => {
    const filing = (symbol: string) => ({ symbol, signal: "insider_sale", form: "4", summary: `Form 4: the CFO sold ${symbol} shares, not under a 10b5-1 plan.` });
    expect(findTriggers(input({ sellFilings: [filing("AAPL"), filing("AAPL"), filing("GGG")] }))).toEqual([
      { symbol: "AAPL", thesisId: "aapl-a", trigger: "sell_filing", price: null, reference: null, distancePct: null, detail: "AAPL: Form 4: the CFO sold AAPL shares, not under a 10b5-1 plan." },
    ]);
  });

  it("skips price triggers on a name bought today, but not a filing", () => {
    const today = input({ price: new Map([["AAPL", "80"]]), previousClose: new Map([["AAPL", "100"]]), boughtToday: new Set(["AAPL"]), sellFilings: [{ symbol: "AAPL", signal: "executive_departure", form: "8-K", summary: "The CEO is leaving." }] });
    expect(kinds(today)).toEqual(["sell_filing"]);
  });

  it("ignores theses not held, and VTI", () => {
    const vti = thesis({ id: "vti-a", symbol: "VTI", stopLossPct: "10" });
    expect(kinds(input({ theses: [aapl, vti], averageCost: new Map([["VTI", "100"]]), price: new Map([["AAPL", "80"], ["VTI", "80"]]) }))).toEqual([]);
  });
});

describe("watchStatus", () => {
  it("gives each held thesis's distances, tripped or not", () => {
    expect(watchStatus(input({ price: new Map([["AAPL", "99"]]), previousClose: new Map([["AAPL", "100"]]) }))).toEqual([
      { symbol: "AAPL", thesisId: "aapl-a", price: "99", stop: "90", abovePct: "10", previousClose: "100", movePct: "-1", boughtToday: false },
    ]);
    expect(watchStatus(input({ price: new Map(), averageCost: new Map([["AAPL", "100"]]) }))[0]).toMatchObject({ price: null, abovePct: null, movePct: null });
  });
});

describe("checkEvents", () => {
  let db: Db;
  let broker: FakeBroker;
  // Monday 2026-11-02: the session is 14:30–21:00 UTC.
  const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00Z`);

  beforeEach(async () => {
    ({ db } = await createTestDb());
    broker = new FakeBroker();
    broker.fill("o1", "AAPL", "buy", "1", "100", new Date("2026-10-28T15:00:00Z"));
    broker.positions = [{ symbol: "AAPL", qty: "1", avgEntryPrice: "100", marketValue: "92", costBasis: "100", currentPrice: "92" }];
    await syncBroker(db, broker, "staging", at("15:00"));
    await submitStrategy(db, strategy({ conviction: [aapl] }), "claude", new Date("2026-10-28T12:00:00Z"));
    // Friday's close, the previous session: $92 is 8% below it, and 2.22% above the $90 stop.
    await db.insert(thesisCloses).values([
      { symbol: "AAPL", tradingDate: "2026-10-29", close: "95" },
      { symbol: "AAPL", tradingDate: "2026-10-30", close: "100" },
    ]);
  });

  const trips = async () => (await db.select().from(auditEvents)).filter((e) => e.kind === "events.tripped");

  it("records each new trip once a day, routed to the digest", async () => {
    const first = await checkEvents(db, broker, at("15:00"));
    expect(first).toMatchObject({ status: "checked", watched: 1 });
    expect(first.status === "checked" && first.tripped.map((t) => t.trigger)).toEqual(["near_stop", "move"]);
    expect((await trips()).map((e) => [e.actor, e.subject])).toEqual([
      ["system", "2026-11-02#AAPL#near_stop"],
      ["system", "2026-11-02#AAPL#move"],
    ]);
    expect((await trips())[0]!.payload).toMatchObject({ thesisId: "aapl-a", price: "92", reference: "90", distancePct: "2.22", at: "2026-11-02T15:00:00.000Z", strategyVersion: 1 });
    expect(await checkEvents(db, broker, at("15:15"))).toEqual({ status: "checked", watched: 1, tripped: [] });
    expect(await trips()).toHaveLength(2);
    expect(routeFor("events.tripped")).toBe("digest");
  });

  it("loads its inputs from the database alone (events:status reads the same)", async () => {
    const { input: loaded, version } = await loadTriggerInput(db, at("15:00"));
    expect(version).toBe(1);
    expect(loaded.averageCost.get("AAPL")).toBe("100");
    expect(loaded.price.get("AAPL")).toBe("92");
    expect(loaded.previousClose.get("AAPL")).toBe("100");
  });

  it("adds a sell-signal filing recorded today", async () => {
    await checkEvents(db, broker, at("15:00"));
    await recordEvent(db, { actor: "system", kind: "filing.sell_signal", subject: "AAPL", payload: { thesisId: "aapl-a", signal: "insider_sale", form: "4", summary: "Form 4: the CFO sold 10,000 shares on the open market, not under a 10b5-1 plan." } });
    const r = await checkEvents(db, broker, at("16:00"));
    expect(r.status === "checked" && r.tripped.map((t) => t.trigger)).toEqual(["sell_filing"]);
    expect(tripSubject("2026-11-02", { symbol: "AAPL", trigger: "sell_filing" })).toBe("2026-11-02#AAPL#sell_filing");
  });

  it("watches only during the session, and not on a holiday", async () => {
    expect(await checkEvents(db, broker, at("14:00"))).toEqual({ status: "skipped", reason: "outside the session" });
    expect(await checkEvents(db, broker, at("21:30"))).toEqual({ status: "skipped", reason: "outside the session" });
    broker.calendar = [];
    expect(await checkEvents(db, broker, at("15:00"))).toEqual({ status: "skipped", reason: "2026-11-02 isn't a trading day" });
    expect(await trips()).toHaveLength(0);
  });

  it("doesn't ask the calendar when nothing new trips", async () => {
    await db.delete(thesisCloses);
    broker.positions = [{ symbol: "AAPL", qty: "1", avgEntryPrice: "100", marketValue: "99", costBasis: "100", currentPrice: "99" }];
    await syncBroker(db, broker, "staging", at("15:00"));
    const calls = broker.calls.getCalendar ?? 0;
    expect(await checkEvents(db, broker, at("15:00"))).toEqual({ status: "checked", watched: 1, tripped: [] });
    expect(broker.calls.getCalendar ?? 0).toBe(calls);
  });

  it("skips price triggers on a name bought today", async () => {
    broker.fill("o2", "AAPL", "buy", "0.1", "92", at("14:45"));
    await syncBroker(db, broker, "staging", at("15:00"));
    const r = await checkEvents(db, broker, at("15:00"));
    expect(r).toMatchObject({ status: "checked", tripped: [] });
  });
});
