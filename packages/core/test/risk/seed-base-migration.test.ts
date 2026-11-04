import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, brokerActivities, capitalFlows, equitySnapshots } from "../../src/db/schema.js";
import { buildIndex } from "../../src/risk/equity-index.js";
import { loadIndexInputs } from "../../src/risk/gate.js";
import { createTestDb } from "../helpers.js";

// Migration 0018 already ran on the empty test database (and wrote nothing);
// re-running it over seeded data is safe because it only inserts missing rows.
const SEED_BASE = readFileSync(new URL("../../drizzle/0018_equity_snapshots_seed_base.sql", import.meta.url), "utf8");
const at = (iso: string) => new Date(iso);

let db: Db;
beforeEach(async () => {
  ({ db } = await createTestDb());
  // Funded in April, all cash until Trader's first fills on Mon Nov 2.
  await db.insert(brokerActivities).values([
    { id: "csd", type: "CSD", at: at("2026-04-17T15:00:00Z"), netAmount: "1000", raw: {} },
    { id: "fill", type: "FILL", at: at("2026-11-02T14:45:00Z"), symbol: "VTI", raw: {} },
  ]);
  await db.insert(capitalFlows).values({ activityId: "csd", at: at("2026-04-17T15:00:00Z"), amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" });
  await db.insert(benchmarkCloses).values([
    { symbol: "VTI", tradingDate: "2026-10-30", close: "371.57" },
    { symbol: "VTI", tradingDate: "2026-11-02", close: "370" },
  ]);
  await db.insert(equitySnapshots).values({ tradingDate: "2026-11-02", equity: "987.83", cash: "0.05", longMarketValue: "987.78", recordedAt: at("2026-11-02T21:00:27Z") });
});

describe("migration 0018: seed the index base", () => {
  it("adds the prior close at the net deposits for an account that was all cash, so day one counts", async () => {
    await db.execute(sql.raw(SEED_BASE));
    await db.execute(sql.raw(SEED_BASE)); // idempotent
    const rows = await db.select().from(equitySnapshots).orderBy(equitySnapshots.tradingDate);
    expect(rows[0]).toMatchObject({ tradingDate: "2026-10-30", equity: "1000", recordedAt: at("2026-10-30T20:00:00Z") });
    expect(rows).toHaveLength(2);

    const { snapshots, flows } = await loadIndexInputs(db);
    expect(buildIndex(snapshots, flows).points.map((p) => p.index)).toEqual(["1", "0.98783"]);
  });

  it("adds nothing when the account traded (or earned anything) before its first snapshot", async () => {
    await db.insert(brokerActivities).values({ id: "old-fill", type: "FILL", at: at("2026-06-01T15:00:00Z"), symbol: "SPY", raw: {} });
    await db.execute(sql.raw(SEED_BASE));
    expect((await db.select().from(equitySnapshots)).map((s) => s.tradingDate)).toEqual(["2026-11-02"]);
  });
});
