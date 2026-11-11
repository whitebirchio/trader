import { desc } from "drizzle-orm";
import { z } from "zod";
import { recordEvent } from "../audit.js";
import type { Db } from "../db/client.js";
import { watchlistNotes } from "../db/schema.js";
import { marketDate } from "../time.js";

/**
 * Claude's research watchlist (#32): names it researched but didn't buy, why,
 * the trigger that would make each a thesis, and when to look again. Each run
 * otherwise started from zero apart from the strategy document. Insert-only:
 * a change is a new row, and a symbol's latest row is its state. It has no
 * trading effect; only submit_strategy reaches the market.
 */

export const WATCHLIST_LIMITS = { perCall: 25, open: 40, revisitMaxDays: 120 } as const;

const DAY_MS = 86_400_000;
const symbol = z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/, "must be a ticker like AAPL or BRK.B");
const why = z.string().trim().min(10, "say why in a sentence").max(600, "keep it to 600 characters");

const change = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("watch"),
    symbol,
    why,
    trigger: z.string().trim().min(10, "say what would make it a thesis").max(400, "keep it to 400 characters"),
    revisitBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  }),
  z.object({ action: z.literal("drop"), symbol, why }),
]);
export type WatchlistChange = z.infer<typeof change>;

export interface WatchlistEntry {
  symbol: string;
  why: string;
  trigger: string;
  revisitBy: string;
  /** Calendar days from today's market date (negative once past). */
  daysToRevisit: number;
  /** Past its revisit date: look at it this run. */
  due: boolean;
  /** When it went on the list, and when its note last changed. */
  watchedSince: string;
  updatedAt: string;
}

type Row = typeof watchlistNotes.$inferSelect;

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Each symbol's current state from its rows, newest first. */
function latest(rows: Row[]): Map<string, { last: Row; watchedSince: Date }> {
  const bySymbol = new Map<string, Row[]>();
  for (const r of rows) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
  const out = new Map<string, { last: Row; watchedSince: Date }>();
  for (const [s, list] of bySymbol) {
    const sorted = list.sort((a, b) => b.at.getTime() - a.at.getTime());
    // The start of the current run of "watch" rows: since the symbol was last dropped.
    let since = sorted[0]!.at;
    for (const r of sorted) {
      if (r.action !== "watch") break;
      since = r.at;
    }
    out.set(s, { last: sorted[0]!, watchedSince: since });
  }
  return out;
}

/** The open watchlist (soonest revisit first) and what was dropped in the last `droppedDays`. */
export async function readWatchlist(db: Db, now: Date, droppedDays = 14): Promise<{ open: WatchlistEntry[]; recentlyDropped: { symbol: string; why: string; at: string }[] }> {
  const rows = await db.select().from(watchlistNotes).orderBy(desc(watchlistNotes.at));
  const today = marketDate(now);
  const since = now.getTime() - droppedDays * DAY_MS;
  const open: WatchlistEntry[] = [];
  const recentlyDropped: { symbol: string; why: string; at: string }[] = [];
  for (const [s, { last, watchedSince }] of latest(rows)) {
    if (last.action === "drop") {
      if (last.at.getTime() >= since) recentlyDropped.push({ symbol: s, why: last.why, at: last.at.toISOString() });
      continue;
    }
    const revisitBy = last.revisitBy!;
    open.push({
      symbol: s,
      why: last.why,
      trigger: last.trigger!,
      revisitBy,
      daysToRevisit: days(today, revisitBy),
      due: revisitBy < today,
      watchedSince: watchedSince.toISOString(),
      updatedAt: last.at.toISOString(),
    });
  }
  open.sort((a, b) => a.revisitBy.localeCompare(b.revisitBy) || a.symbol.localeCompare(b.symbol));
  return { open, recentlyDropped };
}

export type UpdateWatchlistResult = { status: "updated"; watched: string[]; dropped: string[]; open: number } | { status: "rejected"; errors: string[] };

/**
 * Apply a batch of watch/drop changes, all or nothing. A watch needs a reason,
 * a trigger and a revisit date after today, within WATCHLIST_LIMITS'
 * revisitMaxDays; a drop needs a reason and a symbol on the list. At most
 * WATCHLIST_LIMITS.open names stay open. Recorded with one audit event, which
 * the daily digest reports.
 */
export async function updateWatchlist(db: Db, input: unknown, actor: "claude" | "owner", now: Date): Promise<UpdateWatchlistResult> {
  const parsed = z.array(change).min(1, "needs at least one change").max(WATCHLIST_LIMITS.perCall, `at most ${WATCHLIST_LIMITS.perCall} changes at a time`).safeParse(input);
  if (!parsed.success) return { status: "rejected", errors: parsed.error.issues.map((i) => `${i.path.length ? `changes.${i.path.join(".")}: ` : ""}${i.message}`) };
  const changes = parsed.data;

  const today = marketDate(now);
  const errors: string[] = [];
  const seen = new Set<string>();
  const { open } = await readWatchlist(db, now);
  const openNow = new Set(open.map((e) => e.symbol));
  changes.forEach((c, i) => {
    if (seen.has(c.symbol)) errors.push(`changes[${i}]: ${c.symbol} appears more than once`);
    seen.add(c.symbol);
    if (c.action === "drop" && !openNow.has(c.symbol)) errors.push(`changes[${i}]: ${c.symbol} isn't on the watchlist`);
    if (c.action === "watch") {
      const d = new Date(`${c.revisitBy}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== c.revisitBy) errors.push(`changes[${i}].revisitBy: must be a real date`);
      else if (c.revisitBy <= today) errors.push(`changes[${i}].revisitBy: must be after today (${today})`);
      else if (days(today, c.revisitBy) > WATCHLIST_LIMITS.revisitMaxDays) errors.push(`changes[${i}].revisitBy: at most ${WATCHLIST_LIMITS.revisitMaxDays} days out`);
    }
  });
  const after = new Set(openNow);
  for (const c of changes) c.action === "watch" ? after.add(c.symbol) : after.delete(c.symbol);
  if (after.size > WATCHLIST_LIMITS.open) errors.push(`the watchlist would hold ${after.size} names; at most ${WATCHLIST_LIMITS.open} (drop the stalest first)`);
  if (errors.length) return { status: "rejected", errors };

  await db.insert(watchlistNotes).values(
    changes.map((c) => ({ symbol: c.symbol, action: c.action, why: c.why, trigger: c.action === "watch" ? c.trigger : null, revisitBy: c.action === "watch" ? c.revisitBy : null, actor, at: now })),
  );
  const watched = changes.filter((c) => c.action === "watch");
  const dropped = changes.filter((c) => c.action === "drop");
  await recordEvent(db, {
    actor,
    kind: "watchlist.updated",
    subject: changes.map((c) => c.symbol).join(", "),
    payload: {
      watched: watched.map((c) => ({ symbol: c.symbol, trigger: c.trigger, revisitBy: c.revisitBy, new: !openNow.has(c.symbol) })),
      dropped: dropped.map((c) => ({ symbol: c.symbol, why: c.why })),
      open: after.size,
    },
  });
  return { status: "updated", watched: watched.map((c) => c.symbol), dropped: dropped.map((c) => c.symbol), open: after.size };
}

/** For get_overview: how many names are open and which are past their revisit date. */
export async function watchlistSummary(db: Db, now: Date): Promise<{ open: number; due: string[] }> {
  const { open } = await readWatchlist(db, now, 0);
  return { open: open.length, due: open.filter((e) => e.due).map((e) => e.symbol) };
}
