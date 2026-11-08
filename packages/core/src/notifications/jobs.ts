import { capitalOverview } from "../capital/overview.js";
import { activeStrategy } from "../portfolio/store.js";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { auditEvents, notificationItems, notifications } from "../db/schema.js";
import { benchmarkSince } from "../portfolio/benchmark.js";
import type { Db } from "../db/client.js";
import type { TradingEnv } from "../env.js";
import type { JobFn } from "../jobs.js";
import { loadSnapshot } from "../risk/gate.js";
import { LIMITS } from "../risk/limits.js";
import { isLastSessionOfWeek, marketDate, weekMonday } from "../time.js";
import { type NotifiableEvent, composeDigest, composeUrgent, composeWeekly } from "./compose.js";
import { weeklyData } from "./weekly.js";
import { coveredEventIds, deliver, enqueue, foldEvents } from "./outbox.js";
import { DIGEST_KINDS, URGENT_KINDS } from "./routing.js";

/** Urgent events older than this are never emailed (e.g. history from before this module). */
const URGENT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** At most one email per failing job in this window (SPEC-notifications). */
export const JOB_FAILURE_THROTTLE_MS = 6 * 60 * 60_000;
/** The digest goes out this long after the close (the 16:30 ET tick on a normal day). */
export const DIGEST_DELAY_MS = 20 * 60_000;

type EventRow = typeof auditEvents.$inferSelect;

const toNotifiable = (e: EventRow, extra: Record<string, unknown> = {}): NotifiableEvent => ({
  kind: e.kind,
  subject: e.subject,
  payload: { ...e.payload, ...extra },
  at: e.at,
});

/**
 * Email every urgent event not yet emailed, as one message per tick, then
 * deliver everything due (including `notify:test` emails). Repeated failures
 * of the same job are throttled: one email per job per 6 hours, the rest
 * folded in and counted in the next one.
 */
export const notifyUrgent: JobFn = async ({ db, env, mailer, now }) => {
  const at = now();
  const queued = await queueUrgent(db, env, at);
  const delivery = await deliver(db, mailer, at);
  return { status: "succeeded", detail: { ...queued, ...delivery } };
};

export interface QueueUrgentResult {
  events: number;
  folded: number;
  queued: boolean;
}

/**
 * The queueing half of notify-urgent: find un-emailed urgent events, compose
 * one email, enqueue it, fold throttled job failures. No sending, so operator
 * scripts can run it on demand (`notify:run`); delivery stays in the Worker,
 * which holds the send_email binding.
 */
export async function queueUrgent(db: Db, env: TradingEnv, at: Date): Promise<QueueUrgentResult> {
  const recent = await db
    .select()
    .from(auditEvents)
    .where(and(inArray(auditEvents.kind, URGENT_KINDS), gte(auditEvents.at, new Date(at.getTime() - URGENT_LOOKBACK_MS))))
    .orderBy(auditEvents.at);
  const covered = await coveredEventIds(db, "urgent", recent.map((e) => e.id));
  const pending = recent.filter((e) => !covered.has(e.id));

  const send: NotifiableEvent[] = [];
  const sendIds: string[] = [];
  const fold: string[] = [];

  for (const e of pending.filter((x) => x.kind !== "job.failed")) {
    send.push(toNotifiable(e));
    sendIds.push(e.id);
  }

  const failuresByJob = new Map<string, EventRow[]>();
  for (const e of pending.filter((x) => x.kind === "job.failed")) {
    const job = e.subject ?? "unknown";
    failuresByJob.set(job, [...(failuresByJob.get(job) ?? []), e]);
  }
  for (const [job, failures] of failuresByJob) {
    const last = await lastFailureEmailAt(db, job);
    if (last && at.getTime() - last.getTime() < JOB_FAILURE_THROTTLE_MS) {
      fold.push(...failures.map((f) => f.id));
      continue;
    }
    const latest = failures.at(-1);
    if (!latest) continue;
    const earlierFolded = await foldedSince(db, job, last);
    send.push(toNotifiable(latest, { foldedCount: failures.length - 1 + earlierFolded }));
    sendIds.push(latest.id);
    fold.push(...failures.slice(0, -1).map((f) => f.id));
  }

  let queued = false;
  if (send.length > 0) {
    const result = await enqueue(db, env, { type: "urgent", email: composeUrgent(send, env, at), eventIds: sendIds }, at);
    queued = result.status === "queued";
  }
  await foldEvents(db, "urgent", fold, at);
  return { events: send.length, folded: fold.length, queued };
}

async function lastFailureEmailAt(db: Db, job: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: notifications.createdAt })
    .from(notificationItems)
    .innerJoin(auditEvents, eq(auditEvents.id, notificationItems.auditEventId))
    .innerJoin(notifications, eq(notifications.id, notificationItems.notificationId))
    .where(and(eq(notificationItems.type, "urgent"), eq(auditEvents.kind, "job.failed"), eq(auditEvents.subject, job), isNotNull(notificationItems.notificationId)))
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/** Failures of `job` folded (not emailed) since its last failure email. */
async function foldedSince(db: Db, job: string, since: Date | null): Promise<number> {
  const rows = await db
    .select({ at: notificationItems.createdAt })
    .from(notificationItems)
    .innerJoin(auditEvents, eq(auditEvents.id, notificationItems.auditEventId))
    .where(and(eq(notificationItems.type, "urgent"), eq(auditEvents.kind, "job.failed"), eq(auditEvents.subject, job), isNull(notificationItems.notificationId)));
  return rows.filter((r) => !since || r.at > since).length;
}

/**
 * The once-per-trading-day summary, about 20 minutes after the close. Quiet
 * days included: its arrival is the "Trader is alive" signal. Idempotent per
 * date (the digest_date unique key), so later ticks that day are no-ops.
 */
export const notifyDigest: JobFn = async ({ db, env, broker, mailer, now }) => {
  const at = now();
  const today = marketDate(at);
  const existing = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.digestDate, today));
  if (existing.length > 0) {
    await deliver(db, mailer, at);
    return { status: "skipped", reason: "digest already queued today" };
  }

  const session = (await broker.getCalendar(today, today)).find((d) => d.date === today);
  if (!session) return { status: "skipped", reason: "not a trading day" };
  if (at.getTime() < session.close.getTime() + DIGEST_DELAY_MS) return { status: "skipped", reason: "before digest time" };

  const snapshot = await loadSnapshot(db, broker, [], at, LIMITS);
  const benchmark = await benchmarkSince(db, broker, at);
  const money = await capitalOverview(db, snapshot, (await activeStrategy(db, at)).reaffirmedAt);
  const capital = money?.summary ?? null;
  const events = (
    await db
      .select()
      .from(auditEvents)
      .where(and(inArray(auditEvents.kind, DIGEST_KINDS), gte(auditEvents.at, new Date(at.getTime() - 2 * 86_400_000))))
      .orderBy(auditEvents.at)
  ).filter((e) => marketDate(e.at) === today);

  const email = composeDigest(
    {
      date: today,
      equity: snapshot.equity,
      cash: snapshot.cash,
      dailyChangePct: snapshot.index.dailyChangePct,
      drawdownPct: snapshot.index.drawdownPct,
      positions: snapshot.holdings.map((h) => ({ symbol: h.symbol, qty: h.qty, marketValue: h.marketValue })),
      events: events.map((e) => toNotifiable(e)),
      state: { killSwitch: snapshot.state.killSwitch, halted: snapshot.state.halted, haltReason: snapshot.state.haltReason },
      benchmark,
      capital,
      withdrawal: money?.withdrawal ?? null,
    },
    env,
    at,
  );
  const result = await enqueue(db, env, { type: "digest", email, eventIds: events.map((e) => e.id), digestDate: today }, at);
  const delivery = await deliver(db, mailer, at);
  return { status: "succeeded", detail: { date: today, events: events.length, queued: result.status === "queued", ...delivery } };
};

/** The letter waits until today's after-close snapshot exists: the sync writes it within ~30 minutes of the close. */
export const WEEKLY_DELAY_MS = 60 * 60_000;

/**
 * The Friday letter (#38): on the week's last trading session (Thursday in a
 * Friday-holiday week), an hour after the close, once today's equity snapshot
 * exists. Idempotent per week (the week_of unique key).
 */
export const notifyWeekly: JobFn = async ({ db, env, broker, mailer, now }) => {
  const at = now();
  const today = marketDate(at);
  const weekOf = weekMonday(today);
  const existing = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.weekOf, weekOf));
  if (existing.length > 0) {
    await deliver(db, mailer, at);
    return { status: "skipped", reason: "this week's letter already queued" };
  }
  const ahead = new Date(at.getTime() + 10 * 86_400_000).toISOString().slice(0, 10);
  const calendar = await broker.getCalendar(today, ahead);
  const session = calendar.find((d) => d.date === today);
  if (!session) return { status: "skipped", reason: "not a trading day" };
  if (!isLastSessionOfWeek(today, calendar.map((d) => d.date))) return { status: "skipped", reason: "not the week's last session" };
  if (at.getTime() < session.close.getTime() + WEEKLY_DELAY_MS) return { status: "skipped", reason: "before letter time" };

  const data = await weeklyData(db, broker, today, at);
  if ("skip" in data) return { status: "skipped", reason: data.skip };
  const result = await enqueue(db, env, { type: "weekly", email: composeWeekly(data, env, at), eventIds: [], weekOf }, at);
  const delivery = await deliver(db, mailer, at);
  return { status: "succeeded", detail: { weekOf, queued: result.status === "queued", ...delivery } };
};

