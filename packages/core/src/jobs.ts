import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type EarningsCalendarPort, refreshEarningsCalendar } from "./agent/earnings-calendar.js";
import { type EarningsHistoryPort, backfillEarningsHistory, backfillProgress } from "./agent/earnings-history.js";
import { checkFilings, filingTargets } from "./agent/filings.js";
import type { FilingsFeedPort } from "./agent/sec.js";
import { recordEvent } from "./audit.js";
import type { BrokerAdapter } from "./broker/port.js";
import { syncBroker } from "./broker/sync.js";
import { processCapital } from "./capital/commands.js";
import { recordCapitalFlows } from "./capital/ledger.js";
import { checkDrawdown } from "./risk/gate.js";
import type { Db } from "./db/client.js";
import { notifyDigest, notifyUrgent, notifyWeekly } from "./notifications/jobs.js";
import { rebalanceJob } from "./portfolio/rebalance.js";
import type { Mailer } from "./notifications/port.js";
import { jobRuns } from "./db/schema.js";
import type { TradingEnv } from "./env.js";
import { marketDate } from "./time.js";

/** What a job may touch. The engine builds the real ones; tests pass fakes. */
export interface JobDeps {
  db: Db;
  env: TradingEnv;
  broker: BrokerAdapter;
  mailer: Mailer;
  now: () => Date;
  /** The earnings calendar's source (#30); absent without an Alpha Vantage key. */
  earnings?: EarningsCalendarPort;
  /** Alpha Vantage's earnings history, for the backfill (#105); absent without a key. */
  earningsHistory?: EarningsHistoryPort;
  /** SEC EDGAR, for the filings check (#105); absent in tests that don't need it. */
  filings?: FilingsFeedPort;
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
/** A run still `running` this long after it started was cut off (the engine Lambda times out at 5 minutes). */
export const ABANDONED_AFTER_MINUTES = 15;

/**
 * Mark runs that never finished as failed, and audit each like any failed run.
 * A Lambda timeout kills a job mid-way, leaving its row `running` forever;
 * idempotency doesn't care (the next tick has a new slot), but the run history
 * and failure reports would. Compared on the database's clock, like finishedAt.
 */
export async function sweepAbandonedRuns(db: Db): Promise<number> {
  const swept = await db
    .update(jobRuns)
    .set({ status: "failed", error: `abandoned: still running after ${ABANDONED_AFTER_MINUTES} minutes (likely a Lambda timeout)`, finishedAt: dbNow })
    .where(and(eq(jobRuns.status, "running"), lt(jobRuns.startedAt, sql`now() - make_interval(mins => ${ABANDONED_AFTER_MINUTES})`)))
    .returning({ id: jobRuns.id, job: jobRuns.job, scheduledFor: jobRuns.scheduledFor, error: jobRuns.error });
  for (const run of swept) {
    await recordEvent(db, { actor: "system", kind: "job.failed", subject: run.job, jobRunId: run.id, payload: { error: run.error, scheduledFor: run.scheduledFor.toISOString() } });
  }
  return swept.length;
}

const heartbeat: JobFn = async ({ db, env }) => ({ status: "succeeded", detail: { env, abandonedRunsSwept: await sweepAbandonedRuns(db) } });

/** Mirror the Alpaca account into Postgres and refresh the tradingAllowed verdict (SPEC-broker). */
const syncBrokerJob: JobFn = async ({ db, env, broker, now }) => {
  const result = await syncBroker(db, broker, env, now());
  if (result.status === "skipped") return { status: "skipped", reason: result.reason };
  // Transfers reach the ledger before the drawdown check, so a deposit or
  // withdrawal is never measured as a gain or a loss (SPEC-capital).
  const capital = await recordCapitalFlows(db, now());
  // The drawdown check runs on what the sync just wrote. If it fails, the sync
  // still counts: its data is written, and the error is visible in the detail.
  let risk: Record<string, unknown>;
  try {
    risk = { ...(await checkDrawdown(db, now())) };
  } catch (e) {
    risk = { error: e instanceof Error ? e.message : String(e) };
  }
  return { status: "succeeded", detail: { ...result.detail, capital, risk } };
};

/** Owner withdrawal commands, then the open request's next step (SPEC-capital). After sync-broker, so it sees this tick's fills and transfers. */
const processCapitalJob: JobFn = async ({ db, broker, now }) => {
  const result = await processCapital(db, broker, now());
  if (result.status === "idle") return { status: "skipped", reason: "no commands or open withdrawal" };
  const { status: _, ...detail } = result;
  return { status: "succeeded", detail };
};

/** After a failed fetch, wait this long before spending another of the free tier's 25 requests a day. */
const EARNINGS_RETRY_AFTER_MS = 2 * 60 * 60_000;

/**
 * Today's earnings calendar snapshot, once a day (#30). Fails soft: the tools
 * report a stale or missing calendar. Production only: the environments share
 * one free key, so staging's snapshot is fetched on demand with
 * earnings:refresh (Scott, 2026-11-11).
 */
const earningsCalendarJob: JobFn = async ({ db, env, earnings, now }) => {
  if (env === "staging") return { status: "skipped", reason: "no scheduled calendar in staging: run earnings:refresh when a test needs one" };
  if (!earnings) return { status: "skipped", reason: "no ALPHAVANTAGE_API_KEY" };
  const [lastFailure] = await db
    .select({ at: jobRuns.scheduledFor })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "earnings-calendar"), eq(jobRuns.status, "failed"), gte(jobRuns.scheduledFor, new Date(now().getTime() - EARNINGS_RETRY_AFTER_MS))))
    .orderBy(desc(jobRuns.scheduledFor))
    .limit(1);
  if (lastFailure) return { status: "skipped", reason: `the last fetch failed at ${lastFailure.at.toISOString()}; retrying after 2 hours` };
  const result = await refreshEarningsCalendar(db, earnings, now());
  if (result.status === "skipped") return result;
  const { status: _, ...detail } = result;
  return { status: "succeeded", detail };
};

/**
 * The next few companies' earnings history (#105), inside a daily budget of
 * Alpha Vantage requests. After Alpha Vantage refuses one, it waits for the
 * next market date.
 */
const DAY_MS = 86_400_000;

const earningsBackfillJob: JobFn = async ({ db, env, earningsHistory, now }) => {
  if (!earningsHistory) return { status: "skipped", reason: "no ALPHAVANTAGE_API_KEY" };
  const [refused] = await db
    .select({ at: jobRuns.scheduledFor })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "earnings-backfill"), eq(jobRuns.status, "succeeded"), gte(jobRuns.scheduledFor, new Date(now().getTime() - DAY_MS)), sql`${jobRuns.detail}->>'limited' = 'true'`))
    .orderBy(desc(jobRuns.scheduledFor))
    .limit(1);
  if (refused && marketDate(refused.at) === marketDate(now())) return { status: "skipped", reason: `Alpha Vantage refused a request at ${refused.at.toISOString()}; resumes tomorrow` };
  const priority = (await filingTargets(db, now())).map((t) => t.symbol);
  const result = await backfillEarningsHistory(db, earningsHistory, { env, priority, now: now() });
  if (result.status === "skipped") return result;
  const { status: _, ...detail } = result;
  return { status: "succeeded", detail: { ...detail, progress: await backfillProgress(db) } };
};

/** The filings check runs about hourly: this long after the last run (succeeded or failed), it runs again. */
const FILINGS_EVERY_MS = 55 * 60_000;

/** New SEC filings on every held and watched name (#105), about hourly. */
const checkFilingsJob: JobFn = async ({ db, filings, now }) => {
  if (!filings) return { status: "skipped", reason: "no SEC client" };
  const [last] = await db
    .select({ at: jobRuns.scheduledFor })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "check-filings"), inArray(jobRuns.status, ["succeeded", "failed"]), gte(jobRuns.scheduledFor, new Date(now().getTime() - FILINGS_EVERY_MS))))
    .limit(1);
  if (last) return { status: "skipped", reason: `checked at ${last.at.toISOString()}; runs about hourly` };
  const targets = await filingTargets(db, now());
  if (targets.length === 0) return { status: "skipped", reason: "no theses or watchlist names" };
  return { status: "succeeded", detail: { ...(await checkFilings(db, filings, targets, now())) } };
};

/** Every job the engine can run, by name: the tick jobs and the rebalance. */
export const JOBS = {
  heartbeat,
  "sync-broker": syncBrokerJob,
  "process-capital": processCapitalJob,
  "notify-urgent": notifyUrgent,
  "notify-digest": notifyDigest,
  "notify-weekly": notifyWeekly,
  "earnings-calendar": earningsCalendarJob,
  "check-filings": checkFilingsJob,
  "earnings-backfill": earningsBackfillJob,
  // Not in TICK_JOBS: it has its own schedule, 5 minutes after each tick (SPEC-portfolio).
  rebalance: rebalanceJob,
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
export const TICK_JOBS = ["heartbeat", "sync-broker", "process-capital", "earnings-calendar", "check-filings", "earnings-backfill", "notify-urgent", "notify-digest", "notify-weekly"] as const satisfies readonly JobName[];

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(JOBS, name);
}
