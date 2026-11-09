import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { CalendarDay } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { type JobName, runJob } from "../jobs.js";
import type { Mailer } from "../notifications/port.js";
import { submitStrategy } from "../portfolio/store.js";
import { getRiskState, resume } from "../risk/state.js";
import { marketTimeToUtc } from "../time.js";
import { migratedPglite } from "./db.js";
import { SimBroker, type SimMarket } from "./sim-broker.js";

/**
 * The replay driver (#57 T2, tasks/replay-plan.md): walk the sessions from
 * `from` to `to`, running production's own jobs through runJob against a
 * SimBroker and a throwaway PGlite database with the real migrations.
 *
 * Each session runs three steps, in Eastern time:
 *   09:45  sync, capital, rebalance (sells first; sim orders fill at the open)
 *   10:00  sync, capital, rebalance (the sync sees the fills; buys)
 *   16:15  sync, capital (after the close: snapshot, closes, drawdown check)
 * Before each step, strategy versions and transfers whose time has come are
 * applied, versions through the real submitStrategy with their original
 * timestamps. A version authored after 10:00 takes effect next session.
 *
 * A drawdown halt or kill switch freezes trading as it would live; with
 * `autoResume`, the owner's resume runs at the next session's first step.
 * Every halt is reported either way. As in production, resume doesn't
 * re-base the drawdown peak, so an account still 30%+ below its peak halts
 * again at the next sync.
 */

export interface TimelineVersion {
  at: Date;
  authoredBy: "claude" | "owner" | "system";
  /** The strategy document, as stored; validated by submitStrategy. */
  document: unknown;
}

export interface TimelineTransfer {
  at: Date;
  /** Positive: money in. */
  amount: string;
}

export interface ReplayInput {
  market: SimMarket;
  versions: TimelineVersion[];
  transfers: TimelineTransfer[];
  /** First and last session to replay, YYYY-MM-DD (inclusive). */
  from: string;
  to: string;
  slippageBps?: number;
  autoResume?: boolean;
}

export interface ReplayHalt {
  date: string;
  reason: string;
  resumed: boolean;
}

export interface ReplayResult {
  db: Db;
  pglite: PGlite;
  broker: SimBroker;
  sessions: number;
  /** Versions submitStrategy refused (an old document today's schema rejects), with its errors. */
  rejectedVersions: { at: Date; errors: string[] }[];
  halts: ReplayHalt[];
  /** Wall-clock milliseconds per simulated session. */
  msPerSession: number;
}

export const STEPS: { time: string; jobs: JobName[] }[] = [
  { time: "09:45", jobs: ["sync-broker", "process-capital", "rebalance"] },
  { time: "10:00", jobs: ["sync-broker", "process-capital", "rebalance"] },
  { time: "16:15", jobs: ["sync-broker", "process-capital"] },
];

/** The replay never emails: notification jobs don't run, and nothing else sends. */
const silentMailer: Mailer = {
  send: async () => {
    throw new Error("the replay doesn't send email");
  },
};

export async function replay(input: ReplayInput): Promise<ReplayResult> {
  const pglite = await migratedPglite();
  const db = drizzle(pglite, { casing: "snake_case" }) as unknown as Db;
  const sessions: CalendarDay[] = input.market.calendar.filter((d) => d.date >= input.from && d.date <= input.to);
  if (sessions.length === 0) throw new Error(`no sessions between ${input.from} and ${input.to}`);
  const broker = new SimBroker(input.market, { cash: "0", slippageBps: input.slippageBps, now: marketTimeToUtc(sessions[0]!.date, "09:00") });

  const versions = [...input.versions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const transfers = [...input.transfers].sort((a, b) => a.at.getTime() - b.at.getTime());
  const rejectedVersions: ReplayResult["rejectedVersions"] = [];
  const halts: ReplayHalt[] = [];
  let resumePending = false;

  const started = Date.now();
  for (const session of sessions) {
    for (const [i, step] of STEPS.entries()) {
      const at = marketTimeToUtc(session.date, step.time);

      // Money and strategy versions due by now, in time order, each at its own instant.
      while (transfers[0] && transfers[0].at <= at) {
        const t = transfers.shift()!;
        broker.setNow(t.at);
        broker.deposit(t.amount);
      }
      while (versions[0] && versions[0].at <= at) {
        const v = versions.shift()!;
        const result = await submitStrategy(db, v.document, v.authoredBy, v.at);
        if (result.status === "rejected") rejectedVersions.push({ at: v.at, errors: result.errors });
      }
      broker.setNow(at);

      if (i === 0 && resumePending) {
        await resume(db, { actor: "owner", reason: "replay auto-resume after a halt" }, at);
        const last = halts.at(-1);
        if (last) last.resumed = true;
        resumePending = false;
      }

      for (const job of step.jobs) {
        await runJob({ db, env: "staging", broker, mailer: silentMailer, now: () => at }, job, at);
      }

      const state = await getRiskState(db);
      if ((state.halted || state.killSwitch) && !resumePending && !halts.some((h) => !h.resumed)) {
        halts.push({ date: session.date, reason: state.haltReason ?? state.killReason ?? "halted", resumed: false });
        resumePending = input.autoResume === true;
      }
    }
  }
  return { db, pglite, broker, sessions: sessions.length, rejectedVersions, halts, msPerSession: Math.round((Date.now() - started) / sessions.length) };
}
