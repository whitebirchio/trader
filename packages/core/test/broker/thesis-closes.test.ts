import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import { recordThesisCloses, thesisSymbols } from "../../src/broker/thesis-closes.js";
import type { Db } from "../../src/db/client.js";
import { thesisCloses } from "../../src/db/schema.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";
import { FakeBroker } from "./fake-broker.js";

const AFTER_CLOSE = new Date("2026-11-02T21:15:00Z");
let db: Db;
let broker: FakeBroker;

const bar = (date: string, c: string): Bar => ({ t: new Date(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: "1000" });
const stored = () => db.select({ symbol: thesisCloses.symbol, tradingDate: thesisCloses.tradingDate, close: thesisCloses.close }).from(thesisCloses).orderBy(thesisCloses.symbol, thesisCloses.tradingDate);

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  broker.bars = { AAPL: [bar("2026-10-29", "200"), bar("2026-10-30", "202")], MSFT: [bar("2026-10-30", "400")], VTI: [bar("2026-10-30", "300")] };
});

describe("thesisSymbols", () => {
  it("finds each symbol's first version and ignores documents without theses", () => {
    const at = (d: string) => new Date(`${d}T13:00:00Z`);
    const symbols = thesisSymbols([
      { createdAt: at("2026-11-02"), document: { conviction: [{ symbol: "AAPL" }] } },
      { createdAt: at("2026-11-03"), document: { conviction: [{ symbol: "AAPL" }, { symbol: "MSFT" }] } },
      { createdAt: at("2026-11-04"), document: { summary: "no theses" } },
    ]);
    expect([...symbols]).toEqual([["AAPL", at("2026-11-02")], ["MSFT", at("2026-11-03")]]);
  });
});

describe("recordThesisCloses", () => {
  it("stores the closes of every symbol any version has held as a thesis, and on the next run writes only what changed", async () => {
    expect(await recordThesisCloses(db, broker, AFTER_CLOSE)).toBe(0);
    await submitStrategy(db, strategy({ conviction: [thesis({ symbol: "AAPL", id: "aapl-a" })] }), "claude", new Date("2026-11-01T13:00:00Z"));
    await submitStrategy(db, strategy({ conviction: [thesis({ symbol: "MSFT", id: "msft-a" })] }), "claude", new Date("2026-11-02T13:00:00Z"));
    const requests: [string[], string][] = [];
    const getDailyBars = broker.getDailyBars.bind(broker);
    broker.getDailyBars = (async (symbols: string[], start: Date) => {
      requests.push([[...symbols].sort(), start.toISOString()]);
      return getDailyBars(symbols);
    }) as typeof broker.getDailyBars;
    expect(await recordThesisCloses(db, broker, AFTER_CLOSE)).toBe(3);
    expect(requests).toEqual([[["AAPL", "MSFT"], "2025-10-17T13:00:00.000Z"]]); // 380 days before the first version
    expect(await recordThesisCloses(db, broker, AFTER_CLOSE)).toBe(0); // nothing new: nothing rewritten (#89)
    broker.bars.AAPL = [bar("2026-10-29", "199.5"), bar("2026-10-30", "201.5")]; // re-adjusted, as after a dividend
    expect(await recordThesisCloses(db, broker, AFTER_CLOSE)).toBe(2);
    expect(await stored()).toEqual([
      { symbol: "AAPL", tradingDate: "2026-10-29", close: "199.5" },
      { symbol: "AAPL", tradingDate: "2026-10-30", close: "201.5" },
      { symbol: "MSFT", tradingDate: "2026-10-30", close: "400" },
    ]);
  });

  it("is recorded by sync-broker after the close, and a bars failure never blocks the account verdict", async () => {
    await submitStrategy(db, strategy({ conviction: [thesis({ symbol: "AAPL", id: "aapl-a" })] }), "claude", new Date("2026-11-01T13:00:00Z"));
    broker.clock.isOpen = false;
    expect(await syncBroker(db, broker, "staging", AFTER_CLOSE)).toMatchObject({ detail: { phase: "after_close", thesisCloses: 2 } });
    broker.getDailyBars = async () => {
      throw new Error("bars down");
    };
    expect(await syncBroker(db, broker, "staging", AFTER_CLOSE)).toMatchObject({ status: "synced", detail: { thesisCloses: null } });
  });
});
