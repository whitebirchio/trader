import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { auditEvents, strategies, thesisEvents } from "../../src/db/schema.js";
import { activeStrategy, stoppedThesisIds, submitStrategy } from "../../src/portfolio/store.js";
import { VERSION_0 } from "../../src/portfolio/strategy.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "./fixtures.js";

let db: Db;
const now = new Date("2026-11-02T15:00:00Z");
const events = async (kind: string) => (await db.select().from(auditEvents)).filter((e) => e.kind === kind);

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("activeStrategy", () => {
  it("is version 0 (hold VTI) before anything is submitted", async () => {
    expect(await activeStrategy(db, now)).toEqual({ version: 0, authoredBy: "system", createdAt: now, reaffirmedAt: now, strategy: VERSION_0 });
  });

  it("is the highest stored version", async () => {
    await submitStrategy(db, strategy({ summary: "first" }), "owner", now);
    await submitStrategy(db, strategy({ summary: "second" }), "claude", now);
    expect(await activeStrategy(db, now)).toMatchObject({ version: 2, authoredBy: "claude", strategy: { summary: "second" } });
  });

  it("dates the theses from the last version Claude or the owner wrote, not a system one (SPEC-capital)", async () => {
    const claudeAt = new Date("2026-10-01T15:00:00Z");
    await submitStrategy(db, strategy(), "claude", claudeAt);
    await submitStrategy(db, strategy({ summary: "fallback funding" }), "system", now);
    expect(await activeStrategy(db, now)).toMatchObject({ version: 2, authoredBy: "system", createdAt: now, reaffirmedAt: claudeAt });
    const later = new Date("2026-11-03T15:00:00Z");
    await submitStrategy(db, strategy(), "claude", later);
    expect(await activeStrategy(db, later)).toMatchObject({ version: 3, reaffirmedAt: later });
  });

  it("falls back to version 0 if a stored document no longer validates", async () => {
    await db.insert(strategies).values({ authoredBy: "owner", summary: "corrupt", document: { nope: true } });
    expect((await activeStrategy(db, now)).version).toBe(0);
  });
});

describe("submitStrategy", () => {
  it("stores a valid strategy and announces it", async () => {
    expect(await submitStrategy(db, strategy(), "claude", now)).toEqual({ status: "activated", version: 1 });
    const [event] = await events("strategy.activated");
    expect(event).toMatchObject({ actor: "claude", subject: "v1", payload: { version: 1, theses: 1, convictionPct: "10", topN: 2, universeSize: 4 } });
  });

  it("rejects an invalid strategy, audits it, and leaves the active version alone", async () => {
    await submitStrategy(db, strategy(), "owner", now);
    const bad = strategy({ conviction: [thesis({ stopLossPct: "60" })] });
    expect(await submitStrategy(db, bad, "claude", now)).toEqual({
      status: "rejected",
      errors: ["conviction[0].stopLossPct: must be at least 5 and at most 50"],
    });
    expect((await activeStrategy(db, now)).version).toBe(1);
    const [event] = await events("strategy.rejected");
    expect(event).toMatchObject({ actor: "claude", payload: { activeVersion: 1, errors: ["conviction[0].stopLossPct: must be at least 5 and at most 50"] } });
  });

  it("refuses to bring a stopped-out thesis back under the same id", async () => {
    await db.insert(thesisEvents).values({ thesisId: "aapl-services", symbol: "AAPL", kind: "stopped", strategyVersion: 1, reason: "stop" });
    expect(await stoppedThesisIds(db)).toEqual(new Set(["aapl-services"]));
    const result = await submitStrategy(db, strategy(), "claude", now);
    expect(result).toEqual({
      status: "rejected",
      errors: ['conviction[0].id: "aapl-services" was stopped out; re-entering needs a new thesis id'],
    });
    expect(await submitStrategy(db, strategy({ conviction: [thesis({ id: "aapl-services-v2" })] }), "claude", now)).toMatchObject({ status: "activated" });
  });

  it("keeps every version: strategies are insert-only", async () => {
    await submitStrategy(db, strategy(), "owner", now);
    await expect(db.delete(strategies)).rejects.toThrow();
  });
});
