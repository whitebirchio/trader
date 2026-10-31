import { eq, sql } from "drizzle-orm";
import { recordEvent } from "./audit.js";
import type { Db } from "./db/client.js";
import { jobRuns } from "./db/schema.js";
import type { TradingEnv } from "./env.js";

export interface JobContext {
  db: Db;
  env: TradingEnv;
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

/** Every job the engine can run. Later modules register `sync-broker`, `rebalance`, … */
export const JOBS = { heartbeat } satisfies Record<string, JobFn>;
export type JobName = keyof typeof JOBS;

const MAX_ERROR_LENGTH = 2000;

// started_at defaults to the database's now(), so finished_at must use the same
// clock: a Worker's Date only advances across I/O, which skews durations.
const dbNow = sql`now()`;

/**
 * The idempotency slot for a cron firing: its scheduled time floored to the
 * minute. Cloudflare passes the trigger time, but anything sub-minute (local
 * `wrangler dev` passes "now", jitter on redelivery) must not open a second slot.
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
  db: Db,
  env: TradingEnv,
  job: JobName,
  scheduledFor: Date,
  fn: JobFn = JOBS[job],
): Promise<JobOutcome> {
  const claimed = await db
    .insert(jobRuns)
    .values({ job, scheduledFor, status: "running" })
    .onConflictDoNothing({ target: [jobRuns.job, jobRuns.scheduledFor] })
    .returning({ id: jobRuns.id });
  const run = claimed[0];
  if (!run) return { status: "duplicate" };

  let result: JobResult;
  try {
    result = await fn({ db, env, runId: run.id, scheduledFor });
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
