import { beforeEach, describe, expect, it } from "vitest";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { historyView, thesisHeadlines } from "../../src/dashboard/history.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const NOW = new Date("2026-11-02T15:35:00Z");
let db: Db;

beforeEach(async () => {
  ({ db } = await createTestDb());
  const broker = new FakeBroker();
  broker.now = NOW;
  broker.fill("o1", "AAPL", "buy", "1", "200", new Date("2026-10-28T15:00:00Z"));
  broker.positions = [{ symbol: "AAPL", qty: "1", avgEntryPrice: "200", marketValue: "205", costBasis: "200", currentPrice: "205" }];
  broker.account = { ...broker.account, equity: "1005", cash: "800" };
  await syncBroker(db, broker, "staging", NOW);
  // The first version has no headline; a later one adds it. A dropped thesis keeps the last headline it had.
  await submitStrategy(db, strategy({ conviction: [thesis({ headline: undefined, plainSummary: "Apple sells iPhones and the services people pay for on them." }), thesis({ id: "msft-cloud", symbol: "MSFT", headline: "Buying Microsoft because cloud margins keep rising" })] }), "owner", new Date("2026-10-28T12:00:00Z"));
  await submitStrategy(db, strategy({ conviction: [thesis({ headline: "Buying Apple because services keep compounding" })] }), "owner", new Date("2026-10-29T12:00:00Z"));
});

describe("thesisHeadlines", () => {
  it("takes each thesis's headline from the last version that listed it", async () => {
    expect(await thesisHeadlines(db)).toEqual({
      "aapl-services": { text: "Buying Apple because services keep compounding", fallback: false },
      "msft-cloud": { text: "Buying Microsoft because cloud margins keep rising", fallback: false },
    });
  });
});

describe("historyView", () => {
  it("gives the track record, the headlines, and each lead signal's outcomes", async () => {
    const h = await historyView(db, NOW);
    expect(h.track.theses.map((r) => r.symbol)).toEqual(["AAPL"]);
    expect(h.signal.total).toBe("1");
    expect(h.signal.links).toEqual([expect.objectContaining({ value: "1" })]);
    expect(h.signal.nodes.map((n) => n.name)).toEqual(["fundamental", "Still open"]);
  });
});
