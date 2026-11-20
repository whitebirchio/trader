import { compare, sub } from "../money.js";
import { shortDate } from "../time.js";
import type { Block } from "./layout.js";

/**
 * The strategy-activation email (SPEC-notifications § Email design): a subject
 * that says what changed, the change list code computed, the allocation, the
 * first line of Claude's summary, then a card per thesis with Claude's line
 * for it from this run. Reads the `strategy.activated` payload; an older
 * payload without `cards` or `changes` still renders, with less.
 */

interface Card {
  thesisId: string | null;
  symbol: string;
  weightPct: string;
  stopLossPct: string | null;
  reviewBy: string | null;
  leadSignal: string | null;
  beatVtiPct: number | null;
  plainSummary: string | null;
}

interface Changes {
  added: { thesisId: string; symbol: string; weightPct: string }[];
  removed: { thesisId: string; symbol: string; weightPct: string }[];
  resized: { thesisId: string; symbol: string; from: string; to: string }[];
  moved: { thesisId: string; symbol: string; field: "stop" | "review" | "forecast"; from: string | null; to: string | null }[];
  edited: string[];
}

export interface StrategyEmail {
  headline: string;
  preheader: string;
  /** "by Claude", when the headline doesn't already say who. */
  byline: string | null;
  blocks: Block[];
}

export const LEAD_SIGNAL: Record<string, string> = {
  congress: "Led by Congress trades",
  insider: "Led by insider buying",
  "13f": "Led by fund filings (13F)",
  fundamental: "Led by fundamentals",
  news: "Led by news",
  technical: "Led by price action",
  other: "Led by other evidence",
};

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const pct = (v: string) => `${v}%`;
const reviewDate = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? shortDate(d) : (d ?? "none"));

function cardsOf(p: Record<string, unknown>): Card[] {
  if (Array.isArray(p.cards)) {
    return arr<Record<string, unknown>>(p.cards).map((c) => ({
      thesisId: strOrNull(c.thesisId),
      symbol: str(c.symbol),
      weightPct: str(c.weightPct),
      stopLossPct: strOrNull(c.stopLossPct),
      reviewBy: strOrNull(c.reviewBy),
      leadSignal: strOrNull(c.leadSignal),
      beatVtiPct: typeof c.beatVtiPct === "number" ? c.beatVtiPct : null,
      plainSummary: strOrNull(c.plainSummary),
    }));
  }
  // Before the cards (2026-11-15): only the theses with a plain summary were in the payload.
  return arr<Record<string, unknown>>(p.plain).map((t) => ({
    thesisId: null,
    symbol: str(t.symbol),
    weightPct: str(t.targetWeightPct),
    stopLossPct: null,
    reviewBy: null,
    leadSignal: null,
    beatVtiPct: null,
    plainSummary: strOrNull(t.text),
  }));
}

function changesOf(p: Record<string, unknown>): Changes | null {
  const c = p.changes as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object" || typeof p.changed !== "boolean") return null;
  return { added: arr(c.added), removed: arr(c.removed), resized: arr(c.resized), moved: arr(c.moved), edited: arr<string>(c.edited) };
}

/** The subject's short form of the changes: "NVDA 8% added, LKQ exited, BA 9% → 7%". */
export function changeSummary(c: Changes): string {
  const parts = [
    ...c.added.map((a) => `${a.symbol} ${pct(a.weightPct)} added`),
    ...c.removed.map((r) => `${r.symbol} exited`),
    ...c.resized.map((r) => `${r.symbol} ${pct(r.from)} → ${pct(r.to)}`),
  ];
  if (parts.length > 0) return parts.length > 3 ? `${parts.slice(0, 3).join(", ")} +${parts.length - 3} more` : parts.join(", ");
  if (c.moved.some((m) => m.field !== "forecast")) return "stops or review dates moved";
  if (c.moved.length > 0) return "forecasts updated";
  if (c.edited.length === 1) return `${c.edited[0]} updated`;
  if (c.edited.length > 1) return "theses updated";
  return "updated";
}

/** One line per change, for "What changed". */
function changeLines(c: Changes): string[] {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return [
    ...c.added.map((a) => `Added ${a.symbol} at ${pct(a.weightPct)}`),
    ...c.removed.map((r) => `Exited ${r.symbol} (was ${pct(r.weightPct)})`),
    ...c.resized.map((r) => `${r.symbol} resized: ${pct(r.from)} → ${pct(r.to)}`),
    ...c.moved.map((m) =>
      m.field === "stop"
        ? `${m.symbol} stop: ${m.from ?? "none"}% → ${m.to ?? "none"}% below cost`
        : m.field === "review"
          ? `${m.symbol} review date: ${reviewDate(m.from)} → ${reviewDate(m.to)}`
          : `${m.symbol} forecast: ${m.from ?? "none"} → ${m.to ?? "none"} chance to beat VTI`,
    ),
    ...c.edited.map((e) => `${cap(e)} updated`),
  ];
}

export interface SummaryParts {
  lead: string;
  book: string | null;
  perThesis: Map<string, string>;
  notes: string[];
}

const sentences = (s: string): string[] => s.split(/(?<=[.!?])\s+(?=[A-Z"(])/).map((x) => x.trim()).filter(Boolean);

/**
 * Claude's summary, split the way the routine writes it (agent/routine-prompt.md):
 * line 1 says what changed, then `SYMBOL: …` lines that go onto their cards,
 * a `Book: …` line, and anything else as notes. A summary in one long
 * paragraph (before 2026-11-15) is split into sentences instead.
 */
export function splitSummary(summary: string, symbols: Set<string>): SummaryParts {
  const clean = (l: string) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*|__/g, "").trim();
  let lines = summary.split(/\r?\n/).map(clean).filter(Boolean);
  if (lines.length === 1 && lines[0]!.length > 240) lines = sentences(lines[0]!);
  let lead = lines.shift() ?? "";
  if (lead.length > 280) {
    const [first, ...rest] = sentences(lead);
    lead = first ?? lead;
    if (rest.length) lines.unshift(rest.join(" "));
  }
  const perThesis = new Map<string, string>();
  const notes: string[] = [];
  let book: string | null = null;
  for (const line of lines) {
    const m = /^([A-Z][A-Z0-9.]{0,9})(?:\s*\([^)]*\))?\s*[:—–]\s*(.+)$/.exec(line);
    if (m && symbols.has(m[1]!)) {
      perThesis.set(m[1]!, perThesis.has(m[1]!) ? `${perThesis.get(m[1]!)} ${m[2]}` : m[2]!);
      continue;
    }
    const b = /^book:\s*(.+)$/i.exec(line);
    if (b) {
      book = book ? `${book} ${b[1]}` : b[1]!;
      continue;
    }
    notes.push(line);
  }
  return { lead, book, perThesis, notes };
}

export function strategyEmail(p: Record<string, unknown>, dashboard: string | null): StrategyEmail {
  const version = str(p.version);
  const by = str(p.authoredBy);
  const cards = cardsOf(p).sort((a, b) => compare(b.weightPct || "0", a.weightPct || "0") || a.symbol.localeCompare(b.symbol));
  const changes = changesOf(p);
  const unchanged = changes !== null && p.changed === false;
  const headline = changes === null ? `New strategy v${version} by ${by}` : unchanged ? `Strategy v${version} reaffirmed, no changes` : `Strategy v${version}: ${changeSummary(changes)}`;

  const summary = splitSummary(str(p.summary), new Set(cards.map((c) => c.symbol)));
  const blocks: Block[] = [];

  if (changes) {
    const n = cards.length;
    const lines = changeLines(changes);
    blocks.push({ type: "heading", text: "What changed" });
    blocks.push(
      unchanged || lines.length === 0
        ? { type: "paragraph", text: n ? `No changes: same ${n} ${n === 1 ? "thesis" : "theses"}, weights, stops and review dates.` : "No changes." }
        : { type: "list", items: lines },
    );
  }

  const conviction = str(p.convictionPct) || "0";
  const rest = sub("100", conviction);
  const universe = arr<string>(p.universe);
  const idleVti = universe.length ? universe.length === 1 && universe[0] === "VTI" : str(p.universeSize) === "1";
  blocks.push({
    type: "stats",
    items: [
      { label: "In theses", value: pct(conviction) },
      idleVti ? { label: "In VTI", value: pct(rest) } : { label: "Systematic", value: pct(rest), detail: `top ${str(p.topN)} of ${str(p.universeSize)}` },
      { label: "Theses", value: str(p.theses) || String(cards.length) },
    ],
  });

  const voice = by === "claude" ? "Claude" : by === "owner" ? "You" : "Trader";
  if (summary.lead || summary.book) {
    blocks.push({ type: "heading", text: by === "claude" ? "Claude's take" : by === "owner" ? "Your note" : "Note" });
    if (summary.lead) blocks.push({ type: "paragraph", text: summary.lead, size: "lead" });
    if (summary.book) blocks.push({ type: "paragraph", label: "Book:", text: summary.book });
  }

  if (cards.length) {
    const added = new Set(changes?.added.map((a) => a.thesisId));
    const resized = new Map(changes?.resized.map((r) => [r.thesisId, r]));
    blocks.push({ type: "heading", text: "Theses" });
    for (const c of cards) {
      const r = c.thesisId ? resized.get(c.thesisId) : undefined;
      const meta = [
        c.stopLossPct ? `Stop ${c.stopLossPct}% below cost` : null,
        c.reviewBy ? `Review by ${reviewDate(c.reviewBy)}` : null,
        c.leadSignal ? (LEAD_SIGNAL[c.leadSignal] ?? `Led by ${c.leadSignal}`) : null,
        c.beatVtiPct !== null ? `${c.beatVtiPct}% chance to beat VTI` : null,
      ].filter((x): x is string => x !== null);
      const run = summary.perThesis.get(c.symbol);
      blocks.push({
        type: "card",
        title: c.symbol,
        ...(dashboard && c.thesisId ? { href: `${dashboard}/theses/${encodeURIComponent(c.thesisId)}` } : {}),
        badges: c.weightPct ? [pct(c.weightPct)] : [],
        ...(c.thesisId && added.has(c.thesisId) ? { tag: "New" } : r ? { tag: `was ${pct(r.from)}` } : {}),
        blocks: [
          ...(c.plainSummary ? [{ type: "paragraph" as const, text: c.plainSummary }] : []),
          ...(run ? [{ type: "paragraph" as const, label: "This run:", text: run, size: "small" as const }] : []),
        ],
        ...(meta.length ? { meta: meta.join(" · ") } : {}),
      });
    }
  }

  if (summary.notes.length) {
    blocks.push({ type: "heading", text: by === "claude" ? "Claude's notes" : "Notes" });
    for (const n of summary.notes) blocks.push({ type: "paragraph", text: n, size: "small", muted: true });
  }
  if (!unchanged) blocks.push({ type: "paragraph", text: "It takes effect at the next rebalance step.", size: "small", muted: true });

  return { headline, preheader: summary.lead || `${voice} submitted strategy v${version}.`, byline: changes === null ? null : by === "owner" ? "by you" : `by ${voice}`, blocks };
}
