import { beforeEach, describe, expect, it } from "vitest";
import { loadActivities, loadLedger } from "../../src/broker/activities.js";
import { buildLots } from "../../src/broker/lots.js";
import type { Db } from "../../src/db/client.js";
import { brokerActivities } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";

// Each test's database is built in beforeEach, not inside the test: applying every migration
// counts against the test's 5 s limit otherwise, and CI's runner can take most of it.
let db: Db;
beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("loadActivities", () => {
  it("returns every activity oldest first, without the raw payload, and with side normalized", async () => {
    await db.insert(brokerActivities).values([
      { id: "b", type: "FILL", at: new Date("2026-11-03T15:00:00Z"), symbol: "AAPL", side: "sell", qty: "1", price: "210", raw: { big: "payload" } },
      { id: "a", type: "FILL", at: new Date("2026-11-02T15:00:00Z"), symbol: "AAPL", side: "buy", qty: "2", price: "200", raw: {} },
      { id: "c", type: "DIV", at: new Date("2026-11-03T15:00:00Z"), symbol: "AAPL", side: "sell_short", netAmount: "0.50", raw: {} },
    ]);
    const acts = await loadActivities(db);
    expect(acts.map((a) => [a.id, a.side])).toEqual([["a", "buy"], ["b", "sell"], ["c", null]]);
    expect(acts.every((a) => !("raw" in a))).toBe(true);
    expect(acts[2]).toMatchObject({ type: "DIV", netAmount: "0.50", qty: null });
  });
});

describe("loadLedger (#89)", () => {
  const fill = (id: string, at: string, side: "buy" | "sell", qty: string, price: string) => ({ id, type: "FILL", at: new Date(at), symbol: "AAPL", side, qty, price, raw: {} });

  it("gives the same lots as rebuilding them, and reuses them until a new activity arrives", async () => {
    await db.insert(brokerActivities).values([fill("a", "2026-11-02T15:00:00Z", "buy", "2", "200")]);
    const first = await loadLedger(db);
    expect(first.lots).toEqual(buildLots(await loadActivities(db)));
    expect(await loadLedger(db)).toBe(first); // nothing changed: the same object, no rebuild

    // An activity dated before the latest still changes the count, so the lots are rebuilt.
    await db.insert(brokerActivities).values([fill("b", "2026-11-03T15:00:00Z", "sell", "1", "210"), fill("0", "2026-11-01T15:00:00Z", "buy", "1", "190")]);
    const second = await loadLedger(db);
    expect(second).not.toBe(first);
    expect(second.lots).toEqual(buildLots(await loadActivities(db)));
    expect(second.lots.open.map((l) => l.qty)).toEqual(["2"]);

  });

  it("is per database: another database's ledger is its own", async () => {
    await db.insert(brokerActivities).values([fill("a", "2026-11-02T15:00:00Z", "buy", "2", "200")]);
    expect((await loadLedger(db)).lots.open).toHaveLength(1);
    const other = await createTestDb();
    expect((await loadLedger(other.db)).lots.open).toEqual([]);
  }, 15_000);

  it("is frozen, so a caller can't change what the next one reads", async () => {
    await db.insert(brokerActivities).values([fill("a", "2026-11-02T15:00:00Z", "buy", "2", "200")]);
    const { lots, activities } = await loadLedger(db);
    expect(() => (lots.open as unknown[]).push({})).toThrow();
    expect(() => (activities as unknown[]).pop()).toThrow();
  });
});
