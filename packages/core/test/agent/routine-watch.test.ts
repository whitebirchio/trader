import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { FireResult, RoutineFirer } from "../../src/agent/routine-firer.js";
import { ROUTINES, ROUTINE_GRACE_MINUTES, ROUTINE_RUNS_UTC, checkRoutineRuns } from "../../src/agent/routine-watch.js";
import { recordEvent } from "../../src/audit.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { queueUrgent } from "../../src/notifications/jobs.js";
import { describe as describeEvent } from "../../src/notifications/compose.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { FakeMailer } from "../notifications/fake-mailer.js";
import { createTestDb } from "../helpers.js";
import { strategy } from "../portfolio/fixtures.js";

// Monday 2026-11-02, a trading day in FakeBroker's calendar. Runs fire at 13:00 and 17:00 UTC.
const at = (hhmm: string, date = "2026-11-02") => new Date(`${date}T${hhmm}:00Z`);

let db: Db;
let broker: FakeBroker;

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
});

// Audit events take the database's clock, so a submission is written with its time.
const submission = (hhmm: string, kind = "strategy.activated", actor: "claude" | "owner" = "claude") => db.insert(auditEvents).values({ actor, kind, payload: {}, at: at(hhmm) });
const missed = async () => (await db.select().from(auditEvents)).filter((e) => e.kind === "routine.missed");

describe("checkRoutineRuns", () => {
  it("waits out the grace period, then flags a run that submitted nothing, once", async () => {
    expect(await checkRoutineRuns(db, broker, at("13:44"))).toEqual({ status: "skipped", reason: `no run is ${ROUTINE_GRACE_MINUTES} minutes past its fire time yet today` });
    expect(await checkRoutineRuns(db, broker, at("13:45"))).toEqual({ status: "checked", checked: ["2026-11-02T13:00:00.000Z"], missed: ["2026-11-02T13:00:00.000Z"] });
    expect(await checkRoutineRuns(db, broker, at("14:00"))).toMatchObject({ missed: [] });
    const [event] = await missed();
    expect(event).toMatchObject({
      actor: "system",
      subject: "2026-11-02T13:00:00.000Z",
      payload: { firedAt: "2026-11-02T13:00:00.000Z", deadline: "2026-11-02T13:45:00.000Z", activeVersion: 0, activeBy: "system" },
    });
  });

  it("counts a submission, activated or rejected, only for the latest fire time before it", async () => {
    await submission("13:12");
    expect(await checkRoutineRuns(db, broker, at("13:45"))).toMatchObject({ missed: [] });
    // A rejected draft is still a run.
    await submission("17:09", "strategy.rejected");
    expect(await checkRoutineRuns(db, broker, at("17:45"))).toMatchObject({ checked: ["2026-11-02T13:00:00.000Z", "2026-11-02T17:00:00.000Z"], missed: [] });
    expect(await missed()).toEqual([]);
  });

  it("doesn't let the noon run stand in for a missed morning one, or an owner submission for either", async () => {
    await submission("13:20", "strategy.activated", "owner");
    await submission("17:10");
    await submitStrategy(db, strategy(), "owner", at("13:20"));
    await submitStrategy(db, strategy(), "claude", at("17:10"));
    // First checked at 18:00 (say, a deploy mid-day): the morning slot still counts as missed.
    expect(await checkRoutineRuns(db, broker, at("18:00"))).toMatchObject({ missed: ["2026-11-02T13:00:00.000Z"] });
    expect((await missed())[0]!.payload).toMatchObject({ activeVersion: 2, activeBy: "claude" });
  });

  it("asks the calendar only when a run is missing, and stays quiet on a holiday", async () => {
    await submission("13:05");
    await checkRoutineRuns(db, broker, at("13:50"));
    expect(broker.calls.getCalendar ?? 0).toBe(0);
    expect(await checkRoutineRuns(db, broker, at("13:50", "2026-11-03"))).toEqual({ status: "skipped", reason: "2026-11-03 isn't a trading day" });
    expect(await missed()).toEqual([]);
  });
});

describe("checkRoutineRuns with retries (missed-run recovery)", () => {
  const MORNING = "2026-11-02T13:00:00.000Z";
  const kinds = async () => (await db.select().from(auditEvents)).map((e) => e.kind);

  /** Records each fire, and what the audit log held when it was called. */
  function fakeFirer(results: FireResult[] = []) {
    const calls: { triggerId: string; text: string; claimed: boolean }[] = [];
    const firer: RoutineFirer = {
      async fire(triggerId, text) {
        const claims = (await db.select().from(auditEvents)).filter((e) => e.kind === "routine.retry");
        calls.push({ triggerId, text, claimed: claims.length > calls.length });
        return results[calls.length - 1] ?? { status: "fired", sessionUrl: `https://claude.ai/code/session_${calls.length}` };
      },
    };
    return { firer, calls };
  }

  it("re-fires the slot's own routine at +30 and +90 minutes, claiming first, then alerts 45 minutes after the last", async () => {
    const f = fakeFirer();
    expect(await checkRoutineRuns(db, broker, at("13:29"), f.firer)).toMatchObject({ status: "skipped" });
    expect(await checkRoutineRuns(db, broker, at("13:30"), f.firer)).toEqual({ status: "checked", checked: [MORNING], missed: [], retried: [{ slot: MORNING, attempt: 1, outcome: "fired" }] });
    expect(f.calls).toEqual([{ triggerId: ROUTINES[0].triggerId, text: expect.stringContaining("Automatic retry 1 of the Trader research (8:00 ET) run"), claimed: true }]);
    expect(await checkRoutineRuns(db, broker, at("13:45"), f.firer)).toMatchObject({ missed: [], retried: [] });
    expect(await checkRoutineRuns(db, broker, at("14:30"), f.firer)).toMatchObject({ retried: [{ attempt: 2, outcome: "fired" }] });
    expect(await checkRoutineRuns(db, broker, at("15:14"), f.firer)).toMatchObject({ missed: [], retried: [] });
    expect(await checkRoutineRuns(db, broker, at("15:15"), f.firer)).toMatchObject({ missed: [MORNING] });
    expect(f.calls).toHaveLength(2);
    const [event] = await missed();
    expect(event!.payload).toMatchObject({
      deadline: "2026-11-02T15:15:00.000Z",
      retries: [
        { attempt: 1, at: "2026-11-02T13:30:00.000Z", result: { status: "fired" } },
        { attempt: 2, at: "2026-11-02T14:30:00.000Z", result: { status: "fired" } },
      ],
    });
    expect((await kinds()).filter((k) => k.startsWith("routine.retry"))).toEqual(["routine.retry", "routine.retry_result", "routine.retry", "routine.retry_result"]);
  });

  it("stops once the retried run submits", async () => {
    const f = fakeFirer();
    await checkRoutineRuns(db, broker, at("13:30"), f.firer);
    await submission("13:36");
    expect(await checkRoutineRuns(db, broker, at("14:30"), f.firer)).toMatchObject({ missed: [], retried: [] });
    expect(await checkRoutineRuns(db, broker, at("16:00"), f.firer)).toMatchObject({ missed: [] });
    expect(f.calls).toHaveLength(1);
  });

  it("alerts at once when a retry is refused, and doesn't try again", async () => {
    const f = fakeFirer([{ status: "failed", httpStatus: 401, errorType: "authentication_error" }]);
    expect(await checkRoutineRuns(db, broker, at("13:30"), f.firer)).toMatchObject({ missed: [MORNING], retried: [{ attempt: 1, outcome: "failed" }] });
    expect((await missed())[0]!.payload).toMatchObject({ retries: [{ attempt: 1, result: { status: "failed", httpStatus: 401 } }] });
    expect(await checkRoutineRuns(db, broker, at("14:30"), f.firer)).toMatchObject({ missed: [], retried: [] });
    expect(f.calls).toHaveLength(1);
  });

  it("fires each attempt once, however many ticks look", async () => {
    const f = fakeFirer();
    await checkRoutineRuns(db, broker, at("13:30"), f.firer);
    await checkRoutineRuns(db, broker, at("13:31"), f.firer);
    await checkRoutineRuns(db, broker, at("13:46"), f.firer);
    expect(f.calls).toHaveLength(1);
  });

  it("doesn't retry on a holiday, too close to the next run, or after 14:45 ET", async () => {
    const f = fakeFirer();
    expect(await checkRoutineRuns(db, broker, at("13:30", "2026-11-03"), f.firer)).toMatchObject({ status: "skipped", reason: "2026-11-03 isn't a trading day" });
    // First looked at 16:40 (say, after a deploy): the noon run is 20 minutes away, so the morning slot just alerts.
    expect(await checkRoutineRuns(db, broker, at("16:40"), f.firer)).toMatchObject({ missed: [MORNING], retried: [] });
    // The noon slot, first looked at 14:50 ET: past the last retry time.
    expect(await checkRoutineRuns(db, broker, at("19:50"), f.firer)).toMatchObject({ missed: ["2026-11-02T17:00:00.000Z"], retried: [] });
    expect(f.calls).toHaveLength(0);
  });
});

describe("the check-routine job", () => {
  it("records the miss, which goes out in the same tick's urgent email", async () => {
    const deps = { db, env: "production" as const, broker, mailer: new FakeMailer(), now: () => at("13:45") };
    expect(await runJob(deps, "check-routine", at("13:45"))).toMatchObject({ status: "succeeded", detail: { missed: ["2026-11-02T13:00:00.000Z"] } });
    const queued = await queueUrgent(db, "production", at("13:45"));
    expect(queued).toMatchObject({ events: 1, queued: true });
  });

  it("describes the miss for the owner", async () => {
    await recordEvent(db, {
      actor: "system",
      kind: "routine.missed",
      subject: "2026-11-02T13:00:00.000Z",
      payload: { firedAt: "2026-11-02T13:00:00.000Z", deadline: "2026-11-02T13:45:00.000Z", activeVersion: 18, activeBy: "claude", activeSince: "2026-10-30T17:14:32.000Z" },
    });
    const [e] = await db.select().from(auditEvents);
    const d = describeEvent({ kind: e!.kind, subject: e!.subject, payload: e!.payload as Record<string, unknown>, at: e!.at });
    expect(d.headline).toBe("Research run missed");
    expect(d.lines[0]).toMatch(/^The research run due at .+8:00 AM ET hadn't submitted a strategy by .+8:45 AM ET\.$/);
    expect(d.lines[1]).toMatch(/^Strategy v18 \(claude, .+\) keeps executing/);
  });

  it("says what was retried, and what to do about a rejected token", () => {
    const d = describeEvent({
      kind: "routine.missed",
      subject: "2026-11-02T13:00:00.000Z",
      payload: {
        firedAt: "2026-11-02T13:00:00.000Z",
        deadline: "2026-11-02T13:30:00.000Z",
        retries: [{ attempt: 1, at: "2026-11-02T13:30:00.000Z", result: { status: "failed", httpStatus: 401, errorType: "authentication_error" } }],
        activeVersion: 18,
        activeBy: "claude",
        activeSince: "2026-10-30T17:14:32.000Z",
      },
      at: new Date("2026-11-02T13:30:00Z"),
    });
    expect(d.lines[1]).toMatch(/^Retried automatically at .+8:30 AM ET: the retry was refused \(401 authentication_error\)\.$/);
    expect(d.lines[2]).toContain("update ROUTINE_FIRE_TOKENS");
    const ok = describeEvent({
      kind: "routine.retry_result",
      subject: "2026-11-02T13:00:00.000Z#1",
      payload: { attempt: 1, at: "2026-11-02T13:30:00.000Z", routine: "Trader research (8:00 ET)", result: { status: "fired", sessionUrl: "https://claude.ai/code/session_1" } },
      at: new Date("2026-11-02T13:30:00Z"),
    });
    expect(ok.headline).toBe("Research run retried: Trader research (8:00 ET)");
    expect(ok.lines[0]).toMatch(/retry 1 started it again at .+8:30 AM ET \(https:\/\/claude\.ai\/code\/session_1\)\.$/);
  });
});

describe("agent/routines.json", () => {
  const config = JSON.parse(readFileSync(new URL("../../../../agent/routines.json", import.meta.url), "utf8")) as {
    routines: { name: string; triggerId: string; cron: string; model: string; role: string }[];
  };

  it("lists every routine's fire time in ROUTINE_RUNS_UTC, so the missed-run alert looks at the right times", () => {
    const times = config.routines.map((r) => {
      // Only the simple form the alert understands: minute hour * * 1-5 (weekdays, UTC).
      const m = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(r.cron);
      if (!m) throw new Error(`${r.name}: cron "${r.cron}" must be "M H * * 1-5"`);
      return `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
    });
    expect([...times].sort()).toEqual([...ROUTINE_RUNS_UTC].sort());
  });

  it("names a trigger and a Claude model for each", () => {
    for (const r of config.routines) {
      expect(r.triggerId).toMatch(/^trig_\w+$/);
      expect(r.model).toMatch(/^claude-[a-z]+-\d/);
    }
  });

  it("matches ROUTINES' triggers and names, so a retry fires the routine that missed", () => {
    expect(config.routines.map((r) => [r.triggerId, r.name]).sort()).toEqual(ROUTINES.map((r) => [r.triggerId, r.name]).sort());
  });
});
