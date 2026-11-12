import { beforeEach, describe, expect, it } from "vitest";
import { ROUTINE_GRACE_MINUTES, checkRoutineRuns } from "../../src/agent/routine-watch.js";
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
});
