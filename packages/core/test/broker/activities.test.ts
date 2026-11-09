import { describe, expect, it } from "vitest";
import { loadActivities } from "../../src/broker/activities.js";
import { brokerActivities } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";

describe("loadActivities", () => {
  it("returns every activity oldest first, without the raw payload, and with side normalized", async () => {
    const { db } = await createTestDb();
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
