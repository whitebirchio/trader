import { eq, sql } from "drizzle-orm";
import { recordEvent } from "./audit.js";
import type { BrokerAdapter } from "./broker/port.js";
import { syncBroker } from "./broker/sync.js";
import { checkDrawdown } from "./risk/gate.js";
import type { Db } from "./db/client.js";
import { notifyDigest, notifyUrgent } from "./notifications/jobs.js";
import type { Mailer } from "./notifications/port.js";
import { jobRuns } from "./db/schema.js";
import type { TradingEnv } from "./env.js";

/** What a job may touch. The engine builds the real ones; tests pass fakes. */
export interface JobDeps {
  db: Db;
  env: TradingEnv;
  broker: BrokerAdapter;
  mailer: Mailer;
  now: () => Date;
}

export interface JobContext extends JobDeps {
  runId: string;
  scheduledFor: Date;
}

export type JobResult =
  | { status: "succeeded"; detail?: Record<string, unknown> }
  | { status: "skipped"; reason: string };

export type JobOutcome = JobResult | { status: "failed"; error: string } | { status: "duplicate" };

export type JobFn = (ctx: JobContext) => Promise<JobResult>;

/** Proves the scheduler, the database and the deploy are alive; read by getHealth. */
const heartbeat: JobFn = async ({ env }) => ({ status: "succeeded", detail: { env } });

/** Mirror the Alpaca account into Postgres and refresh the tradingAllowed verdict (SPEC-broker). */
const syncBrokerJob: JobFn = async ({ db, env, broker, now }) => {
  const result = await syncBroker(db, broker, env, now());
  if (result.status === "skipped") return { status: "skipped", reason: result.reason };
  // The drawdown check runs on what the sync just wrote. If it fails, the sync
  // still counts: its data is written, and the error is visible in the detail.
  let risk: Record<string, unknown>;
  try {
    risk = { ...(await checkDrawdown(db, now())) };
  } catch (e) {
    risk = { error: e instanceof Error ? e.message : String(e) };
  }
  return { status: "succeeded", detail: { ...result.detail, risk } };
};

/** Every job the engine can run. Later modules register `rebalance`, … */
export const JOBS = {
  heartbeat,
  "sync-broker": syncBrokerJob,
  "notify-urgent": notifyUrgent,
  "notify-digest": notifyDigest,
} satisfies Record<string, JobFn>;
export type JobName = keyof typeof JOBS;

const MAX_ERROR_LENGTH = 2000;

// started_at defaults to the database's now(), so finished_at must use the same
// clock: an app server's clock can differ from the database's, which skews durations.
const dbNow = sql`now()`;

/**
 * The idempotency slot for a cron firing: its scheduled time floored to the
 * minute. EventBridge Scheduler passes the trigger time, but anything sub-minute (a
 * a manual `invoke` passes "now", jitter on redelivery) must not open a second slot.
 */
export function slotFor(scheduledTime: number): Date {
  return new Date(Math.floor(scheduledTime / 60_000) * 60_000);
}

/**
 * Run one job for one scheduled time, at most once (ADR-007). The slot is
 * claimed before the job runs, so a redelivered cron event loses the insert
 * race and becomes a no-op. A job that throws is recorded as failed and
 * audited rather than rethrown: one failing job must not abort the others
 * sharing its cron tick.
 */
export async function runJob(
  deps: JobDeps,
  job: JobName,
  scheduledFor: Date,
  fn: JobFn = JOBS[job],
): Promise<JobOutcome> {
  const { db } = deps;
  const claimed = await db
    .insert(jobRuns)
    .values({ job, scheduledFor, status: "running" })
    .onConflictDoNothing({ target: [jobRuns.job, jobRuns.scheduledFor] })
    .returning({ id: jobRuns.id });
  const run = claimed[0];
  if (!run) return { status: "duplicate" };

  let result: JobResult;
  try {
    result = await fn({ ...deps, runId: run.id, scheduledFor });
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LENGTH);
    await db
      .update(jobRuns)
      .set({ status: "failed", error, finishedAt: dbNow })
      .where(eq(jobRuns.id, run.id));
    await recordEvent(db, {
      actor: "system",
      kind: "job.failed",
      subject: job,
      jobRunId: run.id,
      payload: { error, scheduledFor: scheduledFor.toISOString() },
    });
    return { status: "failed", error };
  }

  const detail = result.status === "skipped" ? { reason: result.reason } : result.detail;
  await db
    .update(jobRuns)
    .set({ status: result.status, detail: detail ?? null, finishedAt: dbNow })
    .where(eq(jobRuns.id, run.id));
  return result;
}

/**
 * The jobs every 15-minute tick runs, in order: sync before rebalance-type
 * work, notifications last so they report this tick's events. The engine's
 * schedule (CDK) and the Lambda handler both use this one list.
 */
export const TICK_JOBS = ["heartbeat", "sync-broker", "notify-urgent", "notify-digest"] as const satisfies readonly JobName[];

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(JOBS, name);
}
