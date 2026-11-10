import { beforeEach, describe, expect, it } from "vitest";
import { writeChangedCloses } from "../../src/broker/closes.js";
import type { Bar } from "../../src/broker/port.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, thesisCloses } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";

let db: Db;
const NOW = new Date("2026-11-03T21:30:00Z");
const bar = (date: string, c: string): Bar => ({ t: new Date(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: "1" });
const stored = async () => (await db.select({ symbol: thesisCloses.symbol, d: thesisCloses.tradingDate, c: thesisCloses.close }).from(thesisCloses)).map((r) => `${r.symbol} ${r.d} ${r.c}`).sort();

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("writeChangedCloses (#89)", () => {
  const first = { AAPL: [bar("2026-10-29", "200"), bar("2026-10-30", "202")], MSFT: [bar("2026-10-30", "400")] };

  it("writes everything the first time, then nothing while nothing changed", async () => {
    expect(await writeChangedCloses(db, thesisCloses, first, NOW)).toBe(3);
    expect(await writeChangedCloses(db, thesisCloses, first, NOW)).toBe(0);
    expect(await stored()).toEqual(["AAPL 2026-10-29 200", "AAPL 2026-10-30 202", "MSFT 2026-10-30 400"]);
  });

  it("writes only a new session when the history it already has is unchanged", async () => {
    await writeChangedCloses(db, thesisCloses, first, NOW);
    expect(await writeChangedCloses(db, thesisCloses, { ...first, AAPL: [...first.AAPL, bar("2026-11-02", "205")] }, NOW)).toBe(1);
    expect(await stored()).toContain("AAPL 2026-11-02 205");
  });

  it("rewrites a symbol whose history was re-adjusted (a split or dividend), and only that symbol", async () => {
    await writeChangedCloses(db, thesisCloses, first, NOW);
    const adjusted = { ...first, AAPL: [bar("2026-10-29", "199.5"), bar("2026-10-30", "201.5"), bar("2026-11-02", "204")] };
    expect(await writeChangedCloses(db, thesisCloses, adjusted, NOW)).toBe(3);
    expect(await stored()).toEqual(["AAPL 2026-10-29 199.5", "AAPL 2026-10-30 201.5", "AAPL 2026-11-02 204", "MSFT 2026-10-30 400"]);
  });

  it("rewrites a symbol when a session it stored is missing from the fetch, or one appears", async () => {
    await writeChangedCloses(db, thesisCloses, first, NOW);
    // An earlier session now in the data, with the same sum by coincidence: the count gives it away.
    expect(await writeChangedCloses(db, thesisCloses, { AAPL: [bar("2026-10-28", "0"), ...first.AAPL] }, NOW)).toBe(3);
  });

  it("only compares from the first fetched session, so a window that moves forward doesn't rewrite", async () => {
    await writeChangedCloses(db, benchmarkCloses, { VTI: [bar("2026-10-28", "299"), bar("2026-10-29", "300"), bar("2026-10-30", "301")] }, NOW);
    expect(await writeChangedCloses(db, benchmarkCloses, { VTI: [bar("2026-10-29", "300"), bar("2026-10-30", "301"), bar("2026-11-02", "302")] }, NOW)).toBe(1);
  });

  it("writes nothing without bars", async () => {
    expect(await writeChangedCloses(db, thesisCloses, {}, NOW)).toBe(0);
    expect(await writeChangedCloses(db, thesisCloses, { AAPL: [] }, NOW)).toBe(0);
  });
});
