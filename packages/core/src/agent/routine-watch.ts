import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { auditEvents, strategies } from "../db/schema.js";
import { marketDate } from "../time.js";

/**
 * Notice a research run that didn't happen. The routine lives in claude.ai,
 * outside the engine, and a run can fail before it starts (the account's
 * weekly usage limit stopped two in November 2026). The last strategy keeps
 * executing, so nothing breaks, but nothing re-judges the theses either, and
 * until now only staleness (30 days) would have said so. Every run on a
 * trading day submits a strategy, unchanged or not, so a missing submission
 * is the signal.
 */

/**
 * The routines' fire times, UTC (8:00 and 12:00 ET in winter): one per
 * routine in agent/routines.json, whose crons a test checks against this.
 * Change both together (#14).
 */
export const ROUTINE_RUNS_UTC = ["13:00", "17:00"] as const;

/** How long after a fire time a submission may still arrive: runs start a few minutes late and take about 5. */
export const ROUTINE_GRACE_MINUTES = 45;

export type RoutineCheckResult = { status: "checked"; checked: string[]; missed: string[] } | { status: "skipped"; reason: string };

const slotAt = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00Z`);

/**
 * For each of today's fire times at least ROUTINE_GRACE_MINUTES past, on a
 * trading day: if Claude submitted nothing (activated or rejected) between it
 * and the next fire time, record `routine.missed` once (urgent). A late
 * submission still counts.
 */
export async function checkRoutineRuns(db: Db, broker: BrokerAdapter, now: Date): Promise<RoutineCheckResult> {
  const today = marketDate(now);
  const due = ROUTINE_RUNS_UTC.map((t) => slotAt(today, t)).filter((s) => now.getTime() >= s.getTime() + ROUTINE_GRACE_MINUTES * 60_000);
  if (due.length === 0) return { status: "skipped", reason: `no run is ${ROUTINE_GRACE_MINUTES} minutes past its fire time yet today` };

  const since = due[0]!;
  const [submissions, alerted] = await Promise.all([
    db
      .select({ at: auditEvents.at })
      .from(auditEvents)
      .where(and(eq(auditEvents.actor, "claude"), inArray(auditEvents.kind, ["strategy.activated", "strategy.rejected"]), gte(auditEvents.at, since))),
    db
      .select({ subject: auditEvents.subject })
      .from(auditEvents)
      .where(and(eq(auditEvents.kind, "routine.missed"), inArray(auditEvents.subject, due.map((s) => s.toISOString())))),
  ]);
  const alreadyAlerted = new Set(alerted.map((a) => a.subject));
  // A submission belongs to the latest fire time before it, so the noon run can't stand in for a missed morning one.
  const slots = ROUTINE_RUNS_UTC.map((t) => slotAt(today, t).getTime());
  const ran = (s: Date) => {
    const next = slots.find((t) => t > s.getTime()) ?? Number.POSITIVE_INFINITY;
    return submissions.some((x) => x.at.getTime() >= s.getTime() && x.at.getTime() < next);
  };
  const missing = due.filter((s) => !alreadyAlerted.has(s.toISOString()) && !ran(s));
  if (missing.length === 0) return { status: "checked", checked: due.map((s) => s.toISOString()), missed: [] };

  // Only now ask the broker: a holiday has no runs to miss (the routine stops without submitting).
  const session = (await broker.getCalendar(today, today)).find((d) => d.date === today);
  if (!session) return { status: "skipped", reason: `${today} isn't a trading day` };

  const [last] = await db
    .select({ version: strategies.version, authoredBy: strategies.authoredBy, createdAt: strategies.createdAt })
    .from(strategies)
    .orderBy(desc(strategies.version))
    .limit(1);
  for (const s of missing) {
    await recordEvent(db, {
      actor: "system",
      kind: "routine.missed",
      subject: s.toISOString(),
      payload: {
        firedAt: s.toISOString(),
        deadline: new Date(s.getTime() + ROUTINE_GRACE_MINUTES * 60_000).toISOString(),
        activeVersion: last?.version ?? 0,
        activeSince: last?.createdAt.toISOString() ?? null,
        activeBy: last?.authoredBy ?? "system",
      },
    });
  }
  return { status: "checked", checked: due.map((s) => s.toISOString()), missed: missing.map((s) => s.toISOString()) };
}
