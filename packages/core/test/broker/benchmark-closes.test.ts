import { beforeEach, describe, expect, it } from "vitest";
import { recordBenchmarkCloses } from "../../src/broker/benchmark-closes.js";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";
import { FakeBroker } from "./fake-broker.js";

const OPEN = new Date("2026-11-02T15:00:00Z");
const AFTER_CLOSE = new Date("2026-11-02T21:15:00Z");
let db: Db;
let broker: FakeBroker;

const bar = (date: string, c: string): Bar => ({ t: new Date(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: "1000" });

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  broker.bars = { VTI: [bar("2026-10-29", "300"), bar("2026-10-30", "301.5")] };
});

const stored = () => db.select({ tradingDate: benchmarkCloses.tradingDate, close: benchmarkCloses.close }).from(benchmarkCloses).orderBy(benchmarkCloses.tradingDate);

describe("recordBenchmarkCloses", () => {
  it("stores VTI's closes by market date, and rewrites them when the broker's adjusted history changes", async () => {
    expect(await recordBenchmarkCloses(db, broker, AFTER_CLOSE)).toBe(2);
    expect(await stored()).toEqual([
      { tradingDate: "2026-10-29", close: "300" },
      { tradingDate: "2026-10-30", close: "301.5" },
    ]);
    // A dividend re-bases the adjusted history; the next run overwrites it.
    broker.bars = { VTI: [bar("2026-10-29", "298.8"), bar("2026-10-30", "300.3"), bar("2026-11-02", "302")] };
    expect(await recordBenchmarkCloses(db, broker, AFTER_CLOSE)).toBe(3);
    expect(await stored()).toEqual([
      { tradingDate: "2026-10-29", close: "298.8" },
      { tradingDate: "2026-10-30", close: "300.3" },
      { tradingDate: "2026-11-02", close: "302" },
    ]);
  });

  it("writes nothing when the broker has no bars", async () => {
    broker.bars = {};
    expect(await recordBenchmarkCloses(db, broker, AFTER_CLOSE)).toBe(0);
    expect(await stored()).toEqual([]);
  });
});

describe("sync-broker records them", () => {
  it("after the close and on forced syncs, not during the session", async () => {
    expect(await syncBroker(db, broker, "staging", OPEN)).toMatchObject({ detail: { benchmarkCloses: null } });
    expect(await stored()).toEqual([]);
    broker.clock.isOpen = false;
    expect(await syncBroker(db, broker, "staging", AFTER_CLOSE)).toMatchObject({ detail: { phase: "after_close", benchmarkCloses: 2 } });
    expect(await syncBroker(db, broker, "staging", new Date("2026-11-01T15:00:00Z"), { ignoreSession: true })).toMatchObject({ detail: { phase: "forced", benchmarkCloses: 2 } });
  });

  it("a broker failure fetching bars never blocks the account verdict", async () => {
    broker.clock.isOpen = false;
    broker.getDailyBars = async () => {
      throw new Error("data API down");
    };
    expect(await syncBroker(db, broker, "staging", AFTER_CLOSE)).toMatchObject({ status: "synced", detail: { benchmarkCloses: null, tradingAllowed: true } });
  });
});
