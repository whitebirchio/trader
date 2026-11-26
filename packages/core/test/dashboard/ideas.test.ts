import { beforeEach, describe, expect, it } from "vitest";
import { updateWatchlist } from "../../src/agent/watchlist.js";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { watchlistNotes } from "../../src/db/schema.js";
import { ideasView, outcomeOf } from "../../src/dashboard/ideas.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const NOW = new Date("2026-11-02T15:35:00Z");
const FORECAST = { beatVtiPct: 40, expectedExcessPct: "-2" };
const watch = (symbol: string, over: object = {}) => ({ action: "watch", symbol, headline: `Buy ${symbol} if margins turn in the 10-Q`, why: `${symbol} looked good but missed the bar`, trigger: `${symbol} files a 10-Q confirming the turn`, revisitBy: "2026-12-15", forecast: FORECAST, ...over });
let db: Db;

beforeEach(async () => {
  ({ db } = await createTestDb());
  // AAPL was watched, then bought; GGG is still watched; HGV was watched and dropped.
  await updateWatchlist(db, [watch("AAPL"), watch("GGG"), watch("HGV")], "claude", new Date("2026-10-26T15:00:00Z"));
  await updateWatchlist(db, [{ action: "drop", symbol: "HGV", why: "Guidance cut: the case is gone" }, { action: "drop", symbol: "AAPL", why: "Bought: now a thesis" }], "claude", new Date("2026-10-28T13:00:00Z"));
  const broker = new FakeBroker();
  broker.now = NOW;
  broker.fill("o1", "AAPL", "buy", "1", "200", new Date("2026-10-28T15:00:00Z"));
  broker.positions = [{ symbol: "AAPL", qty: "1", avgEntryPrice: "200", marketValue: "205", costBasis: "200", currentPrice: "205" }];
  broker.account = { ...broker.account, equity: "1005", cash: "800" };
  await syncBroker(db, broker, "staging", NOW);
  await submitStrategy(db, strategy({ conviction: [thesis()] }), "claude", new Date("2026-10-28T12:00:00Z"));
});

describe("ideasView", () => {
  it("lists what's being watched with its headline, trigger and revisit date", async () => {
    const v = await ideasView(db, NOW);
    expect(v.open.map((c) => c.symbol)).toEqual(["GGG"]);
    expect(v.open[0]).toMatchObject({ headline: { text: "Buy GGG if margins turn in the 10-Q", fallback: false }, trigger: "GGG files a 10-Q confirming the turn", revisitBy: "2026-12-15", due: false, forecast: { beatVtiPct: 40 } });
  });

  it("counts each idea once in the funnel: watched names bought, dropped or still watched, and what the bought ones did", async () => {
    const { funnel } = await ideasView(db, NOW);
    const link = (from: string, to: string) => funnel.links.find((l) => funnel.nodes[l.source]!.name === from && funnel.nodes[l.target]!.name === to)?.value;
    expect(funnel.total).toBe("3");
    expect(link("Watched", "Bought")).toBe("1");
    expect(link("Watched", "Dropped")).toBe("1");
    expect(link("Watched", "Still watching")).toBe("1");
    expect(link("Bought", "Still open")).toBe("1");
  });

  it("falls back to the note's first sentence for a name without a headline", async () => {
    // A new name needs a headline, so the fallback only shows on notes written before them: seed one directly.
    await db.insert(watchlistNotes).values({ symbol: "OLD", action: "watch", why: "An older note. Written before headlines.", trigger: "a cleaner quarter", revisitBy: "2026-12-01", actor: "claude", at: NOW });
    const old = (await ideasView(db, NOW)).open.find((c) => c.symbol === "OLD");
    expect(old?.headline).toEqual({ text: "An older note.", fallback: true });
  });
});

describe("outcomeOf", () => {
  it("is open while held, stopped for a stop, and beat or lagged by the excess once closed", () => {
    const money = (excess: string) => ({ excess }) as never;
    expect(outcomeOf({ ending: "open", money: null })).toBe("open");
    expect(outcomeOf({ ending: "trailing_stopped", money: money("5") })).toBe("stopped");
    expect(outcomeOf({ ending: "removed", money: money("0.01") })).toBe("beat");
    expect(outcomeOf({ ending: "overdue", money: money("-3") })).toBe("lagged");
  });
});
