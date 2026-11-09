import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { auditEvents, jobRuns } from "../src/db/schema.js";
import { runJob, slotFor, sweepAbandonedRuns } from "../src/jobs.js";
import { sql } from "drizzle-orm";
import { createTestDb, deps } from "./helpers.js";

let db: Db;
const scheduledFor = new Date("2026-11-02T14:30:00Z");

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("runJob", () => {
  it("runs the registered heartbeat and records success", async () => {
    const outcome = await runJob(deps(db, "staging"), "heartbeat", scheduledFor);
    expect(outcome).toEqual({ status: "succeeded", detail: { env: "staging", abandonedRunsSwept: 0 } });

    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ job: "heartbeat", status: "succeeded", detail: { env: "staging", abandonedRunsSwept: 0 } });
    expect(run?.scheduledFor.toISOString()).toBe(scheduledFor.toISOString());
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.error).toBeNull();
  });

  it("passes the run context to the job", async () => {
    let seen: unknown;
    await runJob(deps(db, "production"), "heartbeat", scheduledFor, async (ctx) => {
      seen = { env: ctx.env, scheduledFor: ctx.scheduledFor, hasRunId: ctx.runId.length > 0 };
      return { status: "succeeded" };
    });
    expect(seen).toEqual({ env: "production", scheduledFor, hasRunId: true });
  });

  it("records a skip with its reason", async () => {
    const outcome = await runJob(deps(db, "staging"), "heartbeat", scheduledFor, async () => ({
      status: "skipped",
      reason: "market closed",
    }));
    expect(outcome).toEqual({ status: "skipped", reason: "market closed" });
    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ status: "skipped", detail: { reason: "market closed" } });
  });

  it("records a thrown error as failed, audits it, and does not rethrow", async () => {
    const outcome = await runJob(deps(db, "staging"), "heartbeat", scheduledFor, async () => {
      throw new Error("boom");
    });
    expect(outcome).toEqual({ status: "failed", error: "boom" });

    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ status: "failed", error: "boom" });
    expect(run?.finishedAt).toBeInstanceOf(Date);

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "system",
      kind: "job.failed",
      subject: "heartbeat",
      jobRunId: run?.id,
      payload: { error: "boom", scheduledFor: scheduledFor.toISOString() },
    });
  });

  it("treats a second delivery of the same scheduled time as a no-op (ADR-007)", async () => {
    let calls = 0;
    const job = async () => {
      calls++;
      return { status: "succeeded" as const };
    };
    expect(await runJob(deps(db, "staging"), "heartbeat", scheduledFor, job)).toEqual({
      status: "succeeded",
    });
    expect(await runJob(deps(db, "staging"), "heartbeat", scheduledFor, job)).toEqual({
      status: "duplicate",
    });
    expect(calls).toBe(1);
    expect(await db.select().from(jobRuns)).toHaveLength(1);
  });

  it("runs again for the next scheduled time", async () => {
    await runJob(deps(db, "staging"), "heartbeat", scheduledFor);
    await runJob(deps(db, "staging"), "heartbeat", new Date(scheduledFor.getTime() + 15 * 60_000));
    expect(await db.select().from(jobRuns)).toHaveLength(2);
  });
});

describe("sweepAbandonedRuns", () => {
  it("fails runs still running 15+ minutes after they started (a Lambda timeout), audits each, and leaves the rest", async () => {
    const at = (minutesAgo: number) => sql`now() - make_interval(mins => ${minutesAgo})`;
    await db.insert(jobRuns).values([
      { job: "rebalance", scheduledFor: new Date("2026-11-09T15:00:00Z"), status: "running", startedAt: at(20) },
      { job: "sync-broker", scheduledFor: new Date("2026-11-09T15:30:00Z"), status: "running", startedAt: at(2) },
      { job: "heartbeat", scheduledFor: new Date("2026-11-09T14:00:00Z"), status: "succeeded", startedAt: at(60) },
    ]);
    expect(await sweepAbandonedRuns(db)).toBe(1);
    const runs = await db.select({ job: jobRuns.job, status: jobRuns.status, error: jobRuns.error }).from(jobRuns).orderBy(jobRuns.job);
    expect(runs).toEqual([
      { job: "heartbeat", status: "succeeded", error: null },
      { job: "rebalance", status: "failed", error: "abandoned: still running after 15 minutes (likely a Lambda timeout)" },
      { job: "sync-broker", status: "running", error: null },
    ]);
    const events = await db.select({ kind: auditEvents.kind, subject: auditEvents.subject }).from(auditEvents);
    expect(events).toEqual([{ kind: "job.failed", subject: "rebalance" }]);
    expect(await sweepAbandonedRuns(db)).toBe(0);
  });
});

describe("slotFor", () => {
  it("floors a firing to its minute", () => {
    expect(slotFor(Date.parse("2026-11-02T14:30:00.000Z")).toISOString()).toBe(
      "2026-11-02T14:30:00.000Z",
    );
    expect(slotFor(Date.parse("2026-11-02T14:30:59.948Z")).toISOString()).toBe(
      "2026-11-02T14:30:00.000Z",
    );
  });
});

describe("job run timing", () => {
  it("never records finished_at before started_at", async () => {
    await runJob(deps(db, "staging"), "heartbeat", scheduledFor);
    const [run] = await db.select().from(jobRuns);
    expect(run?.finishedAt?.getTime()).toBeGreaterThanOrEqual(run?.startedAt.getTime() ?? Infinity);
  });
});

describe("TICK_JOBS", () => {
  it("lists only registered jobs, heartbeat first and notifications last", async () => {
    const { TICK_JOBS, isJobName } = await import("../src/jobs.js");
    expect(TICK_JOBS.every(isJobName)).toBe(true);
    expect(TICK_JOBS[0]).toBe("heartbeat");
    expect(TICK_JOBS.slice(-3)).toEqual(["notify-urgent", "notify-digest", "notify-weekly"]);
    expect(isJobName("rm -rf")).toBe(false);
  });
});
