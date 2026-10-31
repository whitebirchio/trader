import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { auditEvents } from "../../src/db/schema.js";
import { getRiskState, latchHalt, markBuysPaused, resume, setKillSwitch } from "../../src/risk/state.js";
import { createTestDb } from "../helpers.js";

let db: Db;
const now = new Date("2026-11-02T15:00:00Z");
const owner = (reason: string) => ({ actor: "owner" as const, reason });
const events = async (kind: string) => (await db.select().from(auditEvents)).filter((e) => e.kind === kind);

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("risk state", () => {
  it("starts with trading allowed (seeded by migration)", async () => {
    expect(await getRiskState(db)).toMatchObject({ killSwitch: false, halted: false, buysPausedOn: null });
  });

  it("turns the kill switch on once, as the owner", async () => {
    expect(await setKillSwitch(db, owner("testing"), now)).toEqual({ status: "on" });
    expect(await setKillSwitch(db, owner("again"), now)).toEqual({ status: "already_on" });
    expect(await getRiskState(db)).toMatchObject({ killSwitch: true, killReason: "testing", updatedBy: "owner" });
    const [event] = await events("risk.kill_switch_on");
    expect(event).toMatchObject({ actor: "owner", payload: { reason: "testing" } });
    expect(await events("risk.kill_switch_on")).toHaveLength(1);
  });

  it("latches the halt once, even when two trips race", async () => {
    const results = await Promise.all([
      latchHalt(db, "down 20.4% from peak", { drawdownPct: "20.4" }, now),
      latchHalt(db, "down 20.4% from peak", { drawdownPct: "20.4" }, now),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_halted", "halted"]);
    expect(await events("risk.halted")).toHaveLength(1);
    expect(await getRiskState(db)).toMatchObject({ halted: true, haltReason: "down 20.4% from peak" });
  });

  it("only resume clears the halt and kill switch, and says what it cleared", async () => {
    await latchHalt(db, "down 21% from peak", {}, now);
    await setKillSwitch(db, owner("investigating"), now);
    expect(await resume(db, owner("reviewed; fine"), now)).toEqual({
      status: "resumed",
      cleared: ["kill switch (investigating)", "halt (down 21% from peak)"],
    });
    expect(await getRiskState(db)).toMatchObject({ killSwitch: false, halted: false, haltReason: null, updatedBy: "owner" });
    const [event] = await events("risk.resumed");
    expect(event).toMatchObject({ actor: "owner", payload: { reason: "reviewed; fine" } });
  });

  it("treats a resume with nothing set as a no-op", async () => {
    expect(await resume(db, owner("just checking"), now)).toEqual({ status: "nothing_to_resume" });
    expect(await events("risk.resumed")).toEqual([]);
  });

  it("announces a daily-loss pause once per day, and its end once", async () => {
    expect(await markBuysPaused(db, true, "2026-11-02", { dailyChangePct: "-5.3" }, now)).toBe(true);
    expect(await markBuysPaused(db, true, "2026-11-02", { dailyChangePct: "-6" }, now)).toBe(false);
    expect(await markBuysPaused(db, false, "2026-11-02", {}, now)).toBe(true);
    expect(await markBuysPaused(db, false, "2026-11-02", {}, now)).toBe(false);
    expect(await markBuysPaused(db, true, "2026-11-03", {}, now)).toBe(true); // a new day can pause again
    expect((await events("risk.buys_paused")).length).toBe(2);
    expect((await events("risk.buys_resumed")).length).toBe(1);
  });

  it("refuses non-owner actors at the type level", () => {
    // Never called: this only has to fail typechecking if the guard loosens.
    const neverRun = () => {
      // @ts-expect-error — only "owner" may resume (ADR-012)
      void resume(db, { actor: "claude", reason: "x" }, now);
      // @ts-expect-error — only "owner" may set the kill switch
      void setKillSwitch(db, { actor: "system", reason: "x" }, now);
    };
    expect(typeof neverRun).toBe("function");
  });
});
