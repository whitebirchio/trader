import { z } from "zod";
import { buildLots } from "../broker/lots.js";
import type { Activity } from "../broker/port.js";
import type { DailyBenchmarkClose } from "../capital/shadow.js";
import { add, compare, div, mul, round, sub } from "../money.js";
import { marketDate } from "../time.js";

/**
 * The thesis scorecard (SPEC-portfolio § Scorecard): each thesis ever held,
 * its return, and what the same dollars would have made in VTI. Computed on
 * read from strategy versions, thesis events and fills, never stored, the way
 * lots are rebuilt from fills, so a fix to the math fixes history.
 */

export interface ScorecardVersion {
  version: number;
  createdAt: Date;
  document: unknown;
}

export interface ScorecardThesisEvent {
  thesisId: string;
  /** `stopped` or `stale` (thesis_events). */
  kind: string;
  at: Date;
}

export type ThesisEnding = "open" | "removed" | "stopped" | "stale";

/** One thesis's claim on its symbol, from its first buy until the position is flat after the thesis left. */
export interface ThesisWindow {
  /** The thesis id, then any same-symbol successor that took over while the shares were still held. */
  ids: string[];
  symbol: string;
  /** Evidence kinds in the latest listing of any of `ids`, in document order. */
  kinds: string[];
  openedAt: Date;
  /** When the last of `ids` stopped being the symbol's thesis; null while it still is. */
  leftAt: Date | null;
  /** When the position went flat after `leftAt`; null while shares are held. */
  closedAt: Date | null;
  ending: ThesisEnding;
  /** The thesis's fills, in time order. */
  fills: Activity[];
  /** Why the row can't be scored, or null. */
  unscored: string | null;
}

// Past documents are read leniently: today's schema may reject an old version,
// and the scorecard must still see what it held. Items without a string id and
// symbol are skipped; a version with no readable conviction list is skipped.
const listingSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  evidence: z.array(z.object({ kind: z.string() }).passthrough()).optional().catch(undefined),
});
const documentSchema = z.object({ conviction: z.array(z.unknown()) });

interface Listing {
  id: string;
  symbol: string;
  kinds: string[];
}

function listings(document: unknown): Listing[] | null {
  const doc = documentSchema.safeParse(document);
  if (!doc.success) return null;
  const out: Listing[] = [];
  for (const item of doc.data.conviction) {
    const l = listingSchema.safeParse(item);
    if (l.success) out.push({ id: l.data.id, symbol: l.data.symbol, kinds: (l.data.evidence ?? []).map((e) => e.kind) });
  }
  return out;
}

type Step =
  | { at: Date; order: 0; kind: "version"; listings: Listing[] }
  | { at: Date; order: 1; kind: "stopped" | "stale"; thesisId: string }
  | { at: Date; order: 2; kind: "fill"; fill: Activity };

/**
 * Which fills belong to which thesis. One pass in time order over versions,
 * thesis events and fills, tracking the thesis that claims each symbol:
 * - a window opens at the claiming thesis's first buy, or at the claim itself
 *   if the symbol is already held then (unscored: there's no attributable cost);
 * - it leaves when the claim ends (a stop, staleness, or a version without it)
 *   and closes when the position is next flat, so the sell-out counts;
 * - a new id on the same symbol while shares are held continues the window.
 * Fills outside every window (VTI, the systematic sleeve, manual trades) are ignored.
 */
export function thesisWindows(versions: ScorecardVersion[], events: ScorecardThesisEvent[], activities: Activity[]): ThesisWindow[] {
  const steps: Step[] = [];
  for (const v of versions) {
    const l = listings(v.document);
    if (l) steps.push({ at: v.createdAt, order: 0, kind: "version", listings: l });
  }
  for (const e of events) {
    if (e.kind === "stopped" || e.kind === "stale") steps.push({ at: e.at, order: 1, kind: e.kind, thesisId: e.thesisId });
  }
  for (const a of activities) {
    if (a.type === "FILL" && a.symbol && a.side && a.qty && a.price) steps.push({ at: a.at, order: 2, kind: "fill", fill: a });
  }
  steps.sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order || (a.kind === "fill" && b.kind === "fill" ? a.fill.id.localeCompare(b.fill.id) : 0));

  const lotIssues = new Map<string, string>();
  for (const i of buildLots(activities).issues) if (!lotIssues.has(i.symbol)) lotIssues.set(i.symbol, i.reason);

  const qty = new Map<string, string>();
  const held = (symbol: string) => qty.get(symbol) ?? "0";
  const claims = new Map<string, string>();
  const stopped = new Set<string>();
  const latest = new Map<string, Listing>();
  const open = new Map<string, ThesisWindow>();
  const windows: ThesisWindow[] = [];

  const openWindow = (symbol: string, id: string, at: Date, unscored: string | null) => {
    const w: ThesisWindow = { ids: [id], symbol, kinds: latest.get(id)?.kinds ?? [], openedAt: at, leftAt: null, closedAt: null, ending: "open", fills: [], unscored };
    open.set(symbol, w);
    windows.push(w);
    return w;
  };
  const close = (w: ThesisWindow, at: Date) => {
    w.closedAt = at;
    open.delete(w.symbol);
  };

  // The claim on `symbol` changes to `next` (null: no thesis). `ending` is why the old thesis left, if it did.
  const claim = (symbol: string, next: string | null, at: Date, ending: Exclude<ThesisEnding, "open">) => {
    if (next) claims.set(symbol, next);
    else claims.delete(symbol);
    const flat = compare(held(symbol), "0") <= 0;
    const w = open.get(symbol);
    if (!w) {
      if (next && !flat) openWindow(symbol, next, at, "the symbol was already held when the thesis started");
      return;
    }
    if (next && (w.ids.includes(next) || !flat)) {
      // Reaffirmed or re-added, or a successor taking over shares still held.
      if (!w.ids.includes(next)) w.ids.push(next);
      w.leftAt = null;
      w.ending = "open";
      return;
    }
    if (!w.leftAt) {
      w.leftAt = at;
      w.ending = ending;
    }
    if (flat) close(w, at);
  };

  for (const s of steps) {
    if (s.kind === "version") {
      const next = new Map<string, string>();
      for (const l of s.listings) {
        latest.set(l.id, l);
        if (!stopped.has(l.id) && !next.has(l.symbol)) next.set(l.symbol, l.id);
      }
      for (const symbol of new Set([...claims.keys(), ...next.keys()])) {
        const id = next.get(symbol) ?? null;
        if (claims.get(symbol) !== id) claim(symbol, id, s.at, "removed");
      }
      for (const w of open.values()) w.kinds = latest.get(w.ids.at(-1)!)?.kinds ?? w.kinds;
    } else if (s.kind !== "fill") {
      if (s.kind === "stopped") stopped.add(s.thesisId);
      for (const [symbol, id] of claims) if (id === s.thesisId) claim(symbol, null, s.at, s.kind);
    } else {
      const f = s.fill;
      const symbol = f.symbol!;
      const before = held(symbol);
      qty.set(symbol, f.side === "buy" ? add(before, f.qty!) : sub(before, f.qty!));
      let w = open.get(symbol);
      if (!w) {
        const id = claims.get(symbol);
        if (!id || f.side !== "buy") continue;
        w = openWindow(symbol, id, f.at, null);
      }
      w.fills.push(f);
      if (w.leftAt && compare(held(symbol), "0") <= 0) close(w, f.at);
    }
  }

  for (const w of windows) {
    const issue = lotIssues.get(w.symbol);
    if (issue && !w.unscored) w.unscored = issue;
  }
  return windows;
}

export interface ThesisMoney {
  /** Σ buy qty × price. */
  bought: string;
  /** Σ sell qty × price. */
  proceeds: string;
  /** Dividends paid on the symbol inside the window. */
  dividends: string;
  /** Open quantity × the mark. */
  marketValue: string;
  /** proceeds + dividends + marketValue − bought. */
  pnl: string;
  /** The same dollars in VTI: each buy buys VTI at its day's close, each sell sells the same fraction. */
  vtiPnl: string;
  excess: string;
  /** pnl, vtiPnl and excess as % of `bought`. */
  returnPct: string;
  vtiPct: string;
  excessPct: string;
}

export interface ScorecardRow {
  ids: string[];
  symbol: string;
  /** The most frequent evidence kind (ties: the earliest listed); null without evidence. */
  primaryKind: string | null;
  kinds: string[];
  openedAt: Date;
  leftAt: Date | null;
  closedAt: Date | null;
  ending: ThesisEnding;
  /** Whole days from the first buy to the close, or to `asOf` while held. */
  daysHeld: number;
  /** Shares still held. */
  qty: string;
  unscored: string | null;
  /** Null when unscored. */
  money: ThesisMoney | null;
}

export interface ScoreInputs {
  /** Every activity (dividends are matched to windows by symbol and time). */
  activities: Activity[];
  /** Current price per symbol (positions, last sync). */
  marks: Record<string, string>;
  /** VTI's adjusted closes, ascending. */
  vtiCloses: DailyBenchmarkClose[];
  /** VTI's current price; the latest close if not given. */
  vtiMark?: string;
  asOf: Date;
}

const SHARE_DP = 12;
const DAY_MS = 86_400_000;
const cents = (v: string) => round(v, 2, "half-even");
const pctOf = (part: string, whole: string) => div(mul(part, "100"), whole, 2, "half-even");

/** The most frequent kind; ties go to the earliest listed. */
export function primaryKind(kinds: string[]): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const k of kinds) {
    const count = kinds.filter((x) => x === k).length;
    if (count > bestCount) [best, bestCount] = [k, count];
  }
  return best;
}

/** Score each window: its return on dollars bought vs the same dollars held in VTI (SPEC-portfolio § Scorecard). */
export function scoreTheses(windows: ThesisWindow[], input: ScoreInputs): ScorecardRow[] {
  const closeOn = (date: string) => [...input.vtiCloses].reverse().find((c) => c.tradingDate <= date)?.close;
  const vtiMark = input.vtiMark ?? input.vtiCloses.at(-1)?.close;

  return windows.map((w): ScorecardRow => {
    let qty = "0";
    let bought = "0";
    let proceeds = "0";
    let shadowShares = "0";
    let shadowProceeds = "0";
    let unscored = w.unscored;
    for (const f of w.fills) {
      const dollars = mul(f.qty!, f.price!);
      const close = closeOn(marketDate(f.at));
      if (!close) unscored ??= `no VTI close on or before ${marketDate(f.at)}`;
      if (f.side === "buy") {
        bought = add(bought, dollars);
        if (close) shadowShares = add(shadowShares, div(dollars, close, SHARE_DP, "half-even"));
        qty = add(qty, f.qty!);
      } else {
        proceeds = add(proceeds, dollars);
        if (close && compare(qty, "0") > 0) {
          const sold = compare(f.qty!, qty) >= 0 ? shadowShares : div(mul(shadowShares, f.qty!), qty, SHARE_DP, "half-even");
          shadowProceeds = add(shadowProceeds, mul(sold, close));
          shadowShares = sub(shadowShares, sold);
        }
        qty = sub(qty, f.qty!);
      }
    }
    const dividends = input.activities
      .filter((a) => a.type.startsWith("DIV") && a.symbol === w.symbol && a.netAmount && a.at >= w.openedAt && (!w.closedAt || a.at <= w.closedAt))
      .reduce((sum, a) => add(sum, a.netAmount!), "0");

    const held = compare(qty, "0") > 0;
    const mark = input.marks[w.symbol];
    if (held && !mark) unscored ??= `no current price for ${w.symbol}`;
    if (compare(shadowShares, "0") > 0 && !vtiMark) unscored ??= "no VTI price";
    if (compare(bought, "0") <= 0) unscored ??= "no buys in the window";

    const daysHeld = Math.floor(((w.closedAt ?? input.asOf).getTime() - w.openedAt.getTime()) / DAY_MS);
    const row = { ids: w.ids, symbol: w.symbol, primaryKind: primaryKind(w.kinds), kinds: w.kinds, openedAt: w.openedAt, leftAt: w.leftAt, closedAt: w.closedAt, ending: w.ending, daysHeld, qty };
    if (unscored) return { ...row, unscored, money: null };

    const marketValue = held ? mul(qty, mark!) : "0";
    const pnl = sub(add(add(proceeds, dividends), marketValue), bought);
    const shadowValue = compare(shadowShares, "0") > 0 ? mul(shadowShares, vtiMark!) : "0";
    const vtiPnl = sub(add(shadowProceeds, shadowValue), bought);
    const excess = sub(pnl, vtiPnl);
    return {
      ...row,
      unscored: null,
      money: {
        bought: cents(bought),
        proceeds: cents(proceeds),
        dividends: cents(dividends),
        marketValue: cents(marketValue),
        pnl: cents(pnl),
        vtiPnl: cents(vtiPnl),
        excess: cents(excess),
        returnPct: pctOf(pnl, bought),
        vtiPct: pctOf(vtiPnl, bought),
        excessPct: pctOf(excess, bought),
      },
    };
  });
}

export interface ScorecardRollUp {
  /** Rows in the group, scored or not. */
  theses: number;
  scored: number;
  /** Scored rows whose position is closed. */
  closed: number;
  bought: string;
  pnl: string;
  vtiPnl: string;
  excess: string;
  /** Excess as % of Σ bought; null with nothing bought. */
  excessPct: string | null;
  /** Share of scored rows that beat VTI, %; null with none scored. */
  beatVtiPct: string | null;
  medianDaysHeld: number | null;
}

/** Totals over a group of rows. Unscored rows are counted but left out of the sums. */
export function rollUp(rows: ScorecardRow[]): ScorecardRollUp {
  const scored = rows.filter((r) => r.money);
  const sum = (pick: (m: ThesisMoney) => string) => scored.reduce((s, r) => add(s, pick(r.money!)), "0");
  const bought = sum((m) => m.bought);
  const excess = sum((m) => m.excess);
  const beat = scored.filter((r) => compare(r.money!.excess, "0") > 0).length;
  const days = scored.map((r) => r.daysHeld).sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  return {
    theses: rows.length,
    scored: scored.length,
    closed: scored.filter((r) => r.closedAt).length,
    bought,
    pnl: sum((m) => m.pnl),
    vtiPnl: sum((m) => m.vtiPnl),
    excess,
    excessPct: compare(bought, "0") > 0 ? pctOf(excess, bought) : null,
    beatVtiPct: scored.length > 0 ? pctOf(String(beat), String(scored.length)) : null,
    medianDaysHeld: days.length === 0 ? null : days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2,
  };
}

/** The overall roll-up and one per primary kind, most bought first. */
export function rollUps(rows: ScorecardRow[]): { overall: ScorecardRollUp; byKind: (ScorecardRollUp & { kind: string })[] } {
  const kinds = [...new Set(rows.map((r) => r.primaryKind ?? "none"))];
  const byKind = kinds
    .map((kind) => ({ kind, ...rollUp(rows.filter((r) => (r.primaryKind ?? "none") === kind)) }))
    .sort((a, b) => compare(b.bought, a.bought));
  return { overall: rollUp(rows), byKind };
}
