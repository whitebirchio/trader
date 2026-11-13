import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { auditEvents, strategies } from "../db/schema.js";
import { formatMarketTime, marketDate, marketTimeToUtc } from "../time.js";
import type { FireResult, RoutineFirer } from "./routine-firer.js";

/**
 * Notice a research run that didn't happen, and start it again. The routine
 * lives in claude.ai, outside the engine, and a run can fail before it
 * starts: the account's weekly usage limit stopped two in November 2026, and
 * an Anthropic outage on 2026-11-13 cost the 8:00 run (the scheduled fire
 * never started, and two re-fires couldn't reach the connector). The last
 * strategy keeps executing, so nothing breaks, but nothing re-judges the
 * theses either. Every run on a trading day submits a strategy, unchanged or
 * not, so a missing submission is the signal.
 */

/**
 * The research routines (agent/routines.json, which a test checks against
 * this): each one's fire time in UTC (8:00 and 12:00 ET in winter; #14),
 * its trigger, and its name.
 */
export const ROUTINES = [
  { fireUtc: "13:00", triggerId: "trig_019uVfvbsEyzRfobyggy8kzy", name: "Trader research (8:00 ET)" },
  { fireUtc: "17:00", triggerId: "trig_017KGF6uDScyspH1NEPCfFdX", name: "Trader research (12:00 ET)" },
] as const;
export type Routine = (typeof ROUTINES)[number];

/** The routines' fire times, UTC. Change ROUTINES and agent/routines.json together (#14). */
export const ROUTINE_RUNS_UTC = ROUTINES.map((r) => r.fireUtc);

/** Without retries: how long after a fire time a submission may still arrive (runs start a few minutes late and take about 5). */
export const ROUTINE_GRACE_MINUTES = 45;

/**
 * Retries (SPEC-agent § Missed-run recovery): minutes after the fire time for
 * each attempt; none fired after `lastEt` (a ~5-minute run still submits
 * before the rebalance window closes at 15:30), or within
 * `beforeNextSlotMinutes` of the next routine's fire time (it covers the
 * slot). After the last attempt, a submission has ROUTINE_GRACE_MINUTES.
 */
export const ROUTINE_RETRY = { afterMinutes: [30, 90], lastEt: "14:45", beforeNextSlotMinutes: 30 } as const;

export type RetryOutcome = { slot: string; attempt: number; outcome: FireResult["status"] };
export type RoutineCheckResult = { status: "checked"; checked: string[]; missed: string[]; retried?: RetryOutcome[] } | { status: "skipped"; reason: string };

const MIN = 60_000;
const slotAt = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00Z`);

interface Attempt {
  attempt: number;
  at: Date;
  result: FireResult | null;
}

/**
 * For each of today's fire times on a trading day whose run Claude hasn't
 * submitted for (activated or rejected, between it and the next fire time):
 * - with a `firer`, re-fire that slot's routine at +30 and +90 minutes,
 *   recording `routine.retry` before each call (the claim) and
 *   `routine.retry_result` after (both digest); record `routine.missed`
 *   (urgent) ROUTINE_GRACE_MINUTES after the last attempt, or at once when a
 *   fire is refused;
 * - without one, record `routine.missed` ROUTINE_GRACE_MINUTES after the fire
 *   time, as before retries existed.
 * Each slot is alerted once. A late submission still counts.
 */
export async function checkRoutineRuns(db: Db, broker: BrokerAdapter, now: Date, firer?: RoutineFirer): Promise<RoutineCheckResult> {
  const today = marketDate(now);
  const firstLook = firer ? ROUTINE_RETRY.afterMinutes[0] : ROUTINE_GRACE_MINUTES;
  const slots = ROUTINES.map((r) => ({ routine: r, at: slotAt(today, r.fireUtc) }));
  const due = slots.filter((s) => now.getTime() >= s.at.getTime() + firstLook * MIN);
  if (due.length === 0) return { status: "skipped", reason: `no run is ${firstLook} minutes past its fire time yet today` };

  const iso = due.map((s) => s.at.toISOString());
  const [submissions, alerted, retryRows] = await Promise.all([
    db
      .select({ at: auditEvents.at })
      .from(auditEvents)
      .where(and(eq(auditEvents.actor, "claude"), inArray(auditEvents.kind, ["strategy.activated", "strategy.rejected"]), gte(auditEvents.at, due[0]!.at))),
    db
      .select({ subject: auditEvents.subject })
      .from(auditEvents)
      .where(and(eq(auditEvents.kind, "routine.missed"), inArray(auditEvents.subject, iso))),
    db
      .select({ kind: auditEvents.kind, subject: auditEvents.subject, payload: auditEvents.payload, at: auditEvents.at })
      .from(auditEvents)
      .where(and(inArray(auditEvents.kind, ["routine.retry", "routine.retry_result"]), or(...iso.map((s) => like(auditEvents.subject, `${s}#%`))))),
  ]);
  const alreadyAlerted = new Set(alerted.map((a) => a.subject));
  // A submission belongs to the latest fire time before it, so the noon run can't stand in for a missed morning one.
  const times = slots.map((s) => s.at.getTime());
  const nextSlot = (s: Date) => times.find((t) => t > s.getTime()) ?? Number.POSITIVE_INFINITY;
  const ran = (s: Date) => submissions.some((x) => x.at.getTime() >= s.getTime() && x.at.getTime() < nextSlot(s));

  const attemptsFor = (slot: string): Attempt[] => {
    const out = new Map<number, Attempt>();
    for (const r of retryRows) {
      const [s, n] = (r.subject ?? "").split("#");
      if (s !== slot) continue;
      const attempt = Number(n);
      const p = r.payload as { at?: string; result?: FireResult };
      // The attempt's own time is in its payload: audit rows take the database's clock.
      const a = out.get(attempt) ?? { attempt, at: p.at ? new Date(p.at) : r.at, result: null };
      if (r.kind === "routine.retry" && p.at) a.at = new Date(p.at);
      if (r.kind === "routine.retry_result") a.result = p.result ?? null;
      out.set(attempt, a);
    }
    return [...out.values()].sort((x, y) => x.attempt - y.attempt);
  };

  const lastRetry = marketTimeToUtc(today, ROUTINE_RETRY.lastEt).getTime();
  const retryAllowed = (slot: Date, at: number) => at <= lastRetry && at <= nextSlot(slot) - ROUTINE_RETRY.beforeNextSlotMinutes * MIN;

  type Plan = { kind: "retry"; attempt: number } | { kind: "missed"; deadline: Date; attempts: Attempt[] };
  const plans: { slot: (typeof slots)[number]; plan: Plan }[] = [];
  for (const s of due) {
    const slot = s.at.toISOString();
    if (alreadyAlerted.has(slot) || ran(s.at)) continue;
    if (!firer) {
      if (now.getTime() >= s.at.getTime() + ROUTINE_GRACE_MINUTES * MIN) plans.push({ slot: s, plan: { kind: "missed", deadline: new Date(s.at.getTime() + ROUTINE_GRACE_MINUTES * MIN), attempts: [] } });
      continue;
    }
    const attempts = attemptsFor(slot);
    if (attempts.some((a) => a.result?.status === "failed")) {
      plans.push({ slot: s, plan: { kind: "missed", deadline: now, attempts } });
      continue;
    }
    const next = attempts.length + 1;
    const nextAt = next <= ROUTINE_RETRY.afterMinutes.length ? s.at.getTime() + ROUTINE_RETRY.afterMinutes[next - 1]! * MIN : null;
    if (nextAt !== null && now.getTime() >= nextAt && retryAllowed(s.at, now.getTime())) {
      plans.push({ slot: s, plan: { kind: "retry", attempt: next } });
      continue;
    }
    if (nextAt !== null && now.getTime() < nextAt && retryAllowed(s.at, nextAt)) continue; // the next attempt is still to come
    // No more attempts: the grace period runs from the last one (or the fire time, if none could be made).
    const from = attempts.at(-1)?.at ?? s.at;
    const deadline = new Date(from.getTime() + ROUTINE_GRACE_MINUTES * MIN);
    if (now.getTime() >= deadline.getTime()) plans.push({ slot: s, plan: { kind: "missed", deadline, attempts } });
  }
  const checked = due.map((s) => s.at.toISOString());
  // `retried` only when retries are on, so the result without them is what it was.
  const done = (missed: string[], retried: RetryOutcome[]): RoutineCheckResult => ({ status: "checked", checked, missed, ...(firer ? { retried } : {}) });
  if (plans.length === 0) return done([], []);

  // Only now ask the broker: a holiday has no runs to miss (the routine stops without submitting).
  const session = (await broker.getCalendar(today, today)).find((d) => d.date === today);
  if (!session) return { status: "skipped", reason: `${today} isn't a trading day` };

  const missed: string[] = [];
  const retried: RetryOutcome[] = [];
  let active: { version: number; authoredBy: string; createdAt: Date } | null | undefined;
  for (const { slot: s, plan } of plans) {
    const slot = s.at.toISOString();
    if (plan.kind === "retry") {
      const subject = `${slot}#${plan.attempt}`;
      const base = { slot, attempt: plan.attempt, at: now.toISOString(), triggerId: s.routine.triggerId, routine: s.routine.name };
      // The claim comes first: the fire endpoint has no idempotency key.
      await recordEvent(db, { actor: "system", kind: "routine.retry", subject, payload: base });
      const text = `Automatic retry ${plan.attempt} of the ${s.routine.name} run: the scheduled run hadn't submitted a strategy by ${formatMarketTime(now)}.`;
      const result = await firer!.fire(s.routine.triggerId, text);
      await recordEvent(db, { actor: "system", kind: "routine.retry_result", subject, payload: { ...base, result } });
      retried.push({ slot, attempt: plan.attempt, outcome: result.status });
      if (result.status === "failed") {
        // Refused or unreachable: say so now rather than wait out a grace period for a run that never started.
        const attempts: Attempt[] = [...attemptsFor(slot), { attempt: plan.attempt, at: now, result }];
        await recordMissed(s, now, attempts);
        missed.push(slot);
      }
      continue;
    }
    await recordMissed(s, plan.deadline, plan.attempts);
    missed.push(slot);
  }
  return done(missed, retried);

  async function recordMissed(s: (typeof slots)[number], deadline: Date, attempts: Attempt[]) {
    if (active === undefined) {
      const [last] = await db
        .select({ version: strategies.version, authoredBy: strategies.authoredBy, createdAt: strategies.createdAt })
        .from(strategies)
        .orderBy(desc(strategies.version))
        .limit(1);
      active = last ?? null;
    }
    await recordEvent(db, {
      actor: "system",
      kind: "routine.missed",
      subject: s.at.toISOString(),
      payload: {
        firedAt: s.at.toISOString(),
        deadline: deadline.toISOString(),
        routine: s.routine.name,
        retries: attempts.map((a) => ({ attempt: a.attempt, at: a.at.toISOString(), result: a.result })),
        activeVersion: active?.version ?? 0,
        activeSince: active?.createdAt.toISOString() ?? null,
        activeBy: active?.authoredBy ?? "system",
      },
    });
  }
}
