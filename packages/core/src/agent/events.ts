import { and, desc, eq, gte, inArray, like, lt } from "drizzle-orm";
import { loadLedger } from "../broker/activities.js";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import type { BrokerAdapter } from "../broker/port.js";
import { recordEvent } from "../audit.js";
import type { Db } from "../db/client.js";
import { auditEvents, positions, riskState, thesisCloses } from "../db/schema.js";
import { compare, div, mul, round, sub, toBig } from "../money.js";
import { activeStrategy } from "../portfolio/store.js";
import type { Thesis } from "../portfolio/strategy.js";
import { averageCost, stopLossPrice } from "../portfolio/theses.js";
import { roundTripBlocks } from "../risk/gate.js";
import { formatMarketTime, marketDate, marketTimeToUtc } from "../time.js";
import type { FireResult, RoutineFirer } from "./routine-firer.js";
import { ROUTINES } from "./routine-watch.js";

/**
 * Event-triggered runs (SPEC-agent § Event-triggered runs, #36): notice when a
 * held thesis needs judging between the scheduled runs. A stop is judged on
 * the close and sold the next morning, so a holding sliding toward its stop
 * at 2pm is otherwise settled by the rule, not by Claude.
 *
 * `check-events` records each trip as `events.tripped` (in the digest).
 * With a routine firer, it then starts a focused research run on the 8:00
 * routine (Opus) for the trips still pending, inside a window and under
 * daily caps (EVENT_RUNS). A trip is pending until a Claude submission lands
 * after it, or an event run has named it.
 */

/**
 * The triggers, and (for firing) the window and caps. Owner-set, like LIMITS:
 * ask before changing any of them.
 */
export const EVENT_RUNS = {
  /** Within this % above the stop price (or below it). */
  nearStopPct: "3",
  /** This % or more from the previous session's close, either way. */
  movePct: "8",
  maxPerDay: 2,
  minGapMinutes: 60,
  firstEt: "09:45",
  lastBeforeCloseMinutes: 75,
  inProgressMinutes: 45,
  beforeSlotMinutes: 30,
} as const;

export type EventTrigger = "near_stop" | "move" | "sell_filing";

export interface Tripped {
  symbol: string;
  thesisId: string;
  trigger: EventTrigger;
  /** The latest synced price; null for a filing. */
  price: string | null;
  /** The stop price (near_stop) or the previous close (move); null for a filing. */
  reference: string | null;
  /** % above the stop (near_stop) or from the previous close (move), 2 dp; null for a filing. */
  distancePct: string | null;
  /** One line, as people read it. */
  detail: string;
}

export interface SellFiling {
  symbol: string;
  signal: string;
  form: string;
  summary: string;
}

export interface TriggerInput {
  /** The active strategy's conviction theses. */
  theses: Thesis[];
  /** Average cost per symbol from the open lots, as the stop rule's. Only symbols held. */
  averageCost: Map<string, string>;
  /** The latest synced price per symbol (`positions.current_price`). */
  price: Map<string, string>;
  /** The previous session's close per symbol (`thesis_closes`). */
  previousClose: Map<string, string>;
  /** Today's sell-signal filings (`filing.sell_signal`). */
  sellFilings: SellFiling[];
  /** Bought today: nothing can be sold until tomorrow (no day trades), so price triggers skip them. */
  boughtToday: Set<string>;
}

const MIN = 60_000;
const pctFrom = (price: string, from: string) => round(mul(sub(div(price, from, 12, "half-even"), "1"), "100"), 2, "half-even");
const dollars = (v: string) => `$${toBig(round(v, 2, "half-even")).toFixed(2)}`;
const abs = (v: string) => (v.startsWith("-") ? v.slice(1) : v);

/** Every trigger tripped now by a held thesis: near its stop, a big move, or a sell-signal filing. VTI never trips. */
export function findTriggers(input: TriggerInput): Tripped[] {
  const out: Tripped[] = [];
  for (const t of input.theses) {
    const cost = input.averageCost.get(t.symbol);
    if (t.symbol === BENCHMARK || !cost) continue;
    const price = input.price.get(t.symbol);
    if (price && !input.boughtToday.has(t.symbol)) {
      const stop = stopLossPrice(cost, t.stopLossPct);
      const above = pctFrom(price, stop);
      if (compare(above, EVENT_RUNS.nearStopPct) <= 0) {
        const where = compare(above, "0") < 0 ? `${abs(above)}% below` : `${above}% above`;
        out.push({ symbol: t.symbol, thesisId: t.id, trigger: "near_stop", price, reference: stop, distancePct: above, detail: `${t.symbol} at ${dollars(price)} is ${where} its ${t.stopLossPct}% stop (${dollars(stop)})` });
      }
      const previous = input.previousClose.get(t.symbol);
      if (previous) {
        const move = pctFrom(price, previous);
        if (compare(abs(move), EVENT_RUNS.movePct) >= 0) {
          const dir = compare(move, "0") > 0 ? "rose" : "fell";
          out.push({ symbol: t.symbol, thesisId: t.id, trigger: "move", price, reference: previous, distancePct: move, detail: `${t.symbol} ${dir} ${abs(move)}% from the previous close (${dollars(previous)} → ${dollars(price)})` });
        }
      }
    }
    for (const f of input.sellFilings.filter((x) => x.symbol === t.symbol)) {
      out.push({ symbol: t.symbol, thesisId: t.id, trigger: "sell_filing", price: null, reference: null, distancePct: null, detail: `${t.symbol}: ${f.summary}` });
    }
  }
  // A symbol has one sell_filing trip a day, however many filings land.
  return out.filter((x, i) => x.trigger !== "sell_filing" || out.findIndex((y) => y.trigger === "sell_filing" && y.symbol === x.symbol) === i);
}

export interface WatchRow {
  symbol: string;
  thesisId: string;
  price: string | null;
  stop: string;
  /** % above the stop price (negative below it), 2 dp; null without a price. */
  abovePct: string | null;
  previousClose: string | null;
  /** % from the previous close, 2 dp; null without both. */
  movePct: string | null;
  boughtToday: boolean;
}

/** Each held thesis's distance to its stop and move from the previous close, tripped or not (`events:status`). */
export function watchStatus(input: TriggerInput): WatchRow[] {
  return input.theses.flatMap((t) => {
    const cost = input.averageCost.get(t.symbol);
    if (t.symbol === BENCHMARK || !cost) return [];
    const price = input.price.get(t.symbol) ?? null;
    const previous = input.previousClose.get(t.symbol) ?? null;
    const stop = stopLossPrice(cost, t.stopLossPct);
    return [{ symbol: t.symbol, thesisId: t.id, price, stop, abovePct: price ? pctFrom(price, stop) : null, previousClose: previous, movePct: price && previous ? pctFrom(price, previous) : null, boughtToday: input.boughtToday.has(t.symbol) }];
  });
}

/** `<date>#<symbol>#<trigger>`: once per trigger per symbol per day. */
export const tripSubject = (date: string, t: Pick<Tripped, "symbol" | "trigger">) => `${date}#${t.symbol}#${t.trigger}`;

/** What firing did this tick: started (or tried to start) a run, held pending trips back, or had none. */
export type EventRunOutcome = { status: FireResult["status"]; run: number; trips: string[] } | { status: "waiting"; pending: number; reason: string } | { status: "none" };

export type CheckEventsResult = { status: "checked"; watched: number; tripped: Tripped[]; eventRun?: EventRunOutcome } | { status: "skipped"; reason: string };

/** The routine an event fires: the 8:00 one, on Opus (SPEC-agent § Event-triggered runs). */
export const EVENT_ROUTINE = ROUTINES[0];

/** The fire's text: what tripped, and where the prompt says what to do. The routine's prompt keys on "Event run:". */
export function eventRunText(details: string[]): string {
  return `Event run: ${details.join("; ")}. Judge these holdings first (agent/routine-prompt.md § Event runs).`;
}

/** Everything findTriggers reads, plus the active version and today's recorded trips: shared by checkEvents and `events:status`. */
export async function loadTriggerInput(db: Db, now: Date): Promise<{ input: TriggerInput; version: number; recorded: Set<string> }> {
  const today = marketDate(now);
  const active = await activeStrategy(db, now);
  const theses = active.strategy.conviction;
  const symbols = theses.map((t) => t.symbol);
  const none = ["", ""]; // inArray needs a non-empty list
  const [lots, held, closes, filings, recorded, blocks] = await Promise.all([
    loadLedger(db).then((l) => l.lots),
    db.select({ symbol: positions.symbol, price: positions.currentPrice }).from(positions).where(inArray(positions.symbol, symbols.length ? symbols : none)),
    // The latest close before today for each symbol: a week back covers long weekends.
    db
      .select({ symbol: thesisCloses.symbol, close: thesisCloses.close, tradingDate: thesisCloses.tradingDate })
      .from(thesisCloses)
      .where(and(inArray(thesisCloses.symbol, symbols.length ? symbols : none), lt(thesisCloses.tradingDate, today), gte(thesisCloses.tradingDate, new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10))))
      .orderBy(desc(thesisCloses.tradingDate)),
    db
      .select({ subject: auditEvents.subject, payload: auditEvents.payload })
      .from(auditEvents)
      .where(and(eq(auditEvents.kind, "filing.sell_signal"), gte(auditEvents.at, marketTimeToUtc(today, "00:00")))),
    db
      .select({ subject: auditEvents.subject })
      .from(auditEvents)
      .where(and(eq(auditEvents.kind, "events.tripped"), like(auditEvents.subject, `${today}#%`))),
    roundTripBlocks(db, now),
  ]);

  const cost = new Map<string, string>();
  for (const s of symbols) {
    const c = averageCost(lots.open, s);
    if (c) cost.set(s, c);
  }
  const previousClose = new Map<string, string>();
  for (const c of closes) if (!previousClose.has(c.symbol)) previousClose.set(c.symbol, c.close);
  const sellFilings = filings.map((f) => {
    const p = f.payload as { signal?: unknown; form?: unknown; summary?: unknown };
    return { symbol: f.subject ?? "", signal: String(p.signal ?? ""), form: String(p.form ?? ""), summary: String(p.summary ?? "") };
  });
  return {
    input: { theses, averageCost: cost, price: new Map(held.map((h) => [h.symbol, h.price])), previousClose, sellFilings, boughtToday: blocks.sell },
    version: active.version,
    recorded: new Set(recorded.map((r) => r.subject ?? "")),
  };
}

/**
 * During the session, record `events.tripped` for each trigger a held thesis
 * newly trips today (SPEC-agent § Event-triggered runs). It fires nothing
 * yet. The kill switch doesn't stop it: the owner and the next run should
 * still see what happened.
 */
export async function checkEvents(db: Db, broker: BrokerAdapter, now: Date, firer?: RoutineFirer): Promise<CheckEventsResult> {
  const today = marketDate(now);
  // A cheap gate first; the calendar (holidays, half days) is asked only when something trips.
  if (now < marketTimeToUtc(today, "09:30") || now > marketTimeToUtc(today, "16:00")) return { status: "skipped", reason: "outside the session" };
  const { input, version, recorded } = await loadTriggerInput(db, now);
  if (input.theses.length === 0) return { status: "skipped", reason: "no theses" };
  const fresh = findTriggers(input).filter((t) => !recorded.has(tripSubject(today, t)));
  let calendar: Promise<{ open: Date; close: Date } | null> | undefined;
  const sessionToday = () => (calendar ??= broker.getCalendar(today, today).then((days) => days.find((d) => d.date === today) ?? null));
  if (fresh.length) {
    const session = await sessionToday();
    if (!session) return { status: "skipped", reason: `${today} isn't a trading day` };
    if (now < session.open || now > session.close) return { status: "skipped", reason: "outside the session" };
    for (const t of fresh) {
      await recordEvent(db, { actor: "system", kind: "events.tripped", subject: tripSubject(today, t), payload: { ...t, at: now.toISOString(), strategyVersion: version } });
    }
  }
  const checked = { status: "checked" as const, watched: input.averageCost.size, tripped: fresh };
  // `eventRun` only with a firer, so the result without one is PR 1's.
  return firer ? { ...checked, eventRun: await fireForPending(db, now, firer, sessionToday) } : checked;
}

/**
 * Start one event run for today's pending trips, if the window and caps
 * allow (SPEC-agent § Event-triggered runs). The claim (`routine.event_run`)
 * is recorded before the call, as the fire endpoint has no idempotency key;
 * the outcome follows as `routine.event_run_result`. A refused fire isn't
 * retried: its trips stay named, and the next scheduled run sees them.
 */
async function fireForPending(db: Db, now: Date, firer: RoutineFirer, sessionToday: () => Promise<{ open: Date; close: Date } | null>): Promise<EventRunOutcome> {
  const today = marketDate(now);
  const [trips, runs, submissions, [state]] = await Promise.all([
    db
      .select({ subject: auditEvents.subject, payload: auditEvents.payload, at: auditEvents.at })
      .from(auditEvents)
      .where(and(eq(auditEvents.kind, "events.tripped"), like(auditEvents.subject, `${today}#%`))),
    db
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(and(eq(auditEvents.kind, "routine.event_run"), like(auditEvents.subject, `${today}#%`))),
    db
      .select({ at: auditEvents.at })
      .from(auditEvents)
      .where(and(eq(auditEvents.actor, "claude"), inArray(auditEvents.kind, ["strategy.activated", "strategy.rejected"]), gte(auditEvents.at, marketTimeToUtc(today, "00:00")))),
    db.select({ killSwitch: riskState.killSwitch }).from(riskState).limit(1),
  ]);
  // Event times are in their payloads: audit rows take the database's clock.
  const atOf = (row: { payload: unknown; at?: Date }) => {
    const at = (row.payload as { at?: unknown }).at;
    return typeof at === "string" ? new Date(at) : (row.at ?? now);
  };
  const named = new Set(runs.flatMap((r) => ((r.payload as { trips?: { subject?: unknown }[] }).trips ?? []).map((t) => String(t.subject))));
  const pending = trips.filter((t) => !named.has(t.subject ?? "") && !submissions.some((s) => s.at > atOf(t))).sort((a, b) => atOf(a).getTime() - atOf(b).getTime());
  if (pending.length === 0) return { status: "none" };
  const wait = (reason: string): EventRunOutcome => ({ status: "waiting", pending: pending.length, reason });

  if (state?.killSwitch) return wait("the kill switch is on");
  const session = await sessionToday();
  if (!session) return wait(`${today} isn't a trading day`);
  const first = marketTimeToUtc(today, EVENT_RUNS.firstEt);
  const last = new Date(session.close.getTime() - EVENT_RUNS.lastBeforeCloseMinutes * MIN);
  if (now < first) return wait(`event runs start at ${formatMarketTime(first)}`);
  if (now > last) return wait(`no event run after ${formatMarketTime(last)}, ${EVENT_RUNS.lastBeforeCloseMinutes} minutes before the close`);
  for (const r of ROUTINES) {
    const slot = new Date(`${today}T${r.fireUtc}:00Z`);
    const until = slot.getTime() - now.getTime();
    if (until > 0 && until <= EVENT_RUNS.beforeSlotMinutes * MIN) return wait(`${r.name} is due at ${formatMarketTime(slot)} and will cover it`);
    if (until <= 0 && -until < EVENT_RUNS.inProgressMinutes * MIN && !submissions.some((s) => s.at >= slot)) return wait(`${r.name} is in progress`);
  }
  if (runs.length >= EVENT_RUNS.maxPerDay) return wait(`${EVENT_RUNS.maxPerDay} event runs already today`);
  const lastRun = runs.map(atOf).sort((a, b) => b.getTime() - a.getTime())[0];
  if (lastRun && now.getTime() - lastRun.getTime() < EVENT_RUNS.minGapMinutes * MIN) return wait(`the last event run was at ${formatMarketTime(lastRun)}, under ${EVENT_RUNS.minGapMinutes} minutes ago`);

  const run = runs.length + 1;
  const subject = `${today}#${run}`;
  const listed = pending.map((t) => {
    const p = t.payload as { symbol?: unknown; trigger?: unknown; detail?: unknown };
    return { subject: t.subject ?? "", symbol: String(p.symbol ?? ""), trigger: String(p.trigger ?? ""), detail: String(p.detail ?? "") };
  });
  const text = eventRunText(listed.map((t) => t.detail));
  const base = { run, at: now.toISOString(), triggerId: EVENT_ROUTINE.triggerId, routine: EVENT_ROUTINE.name, trips: listed, text };
  await recordEvent(db, { actor: "system", kind: "routine.event_run", subject, payload: base });
  const result = await firer.fire(EVENT_ROUTINE.triggerId, text);
  await recordEvent(db, { actor: "system", kind: "routine.event_run_result", subject, payload: { ...base, result } });
  return { status: result.status, run, trips: listed.map((t) => t.subject) };
}
