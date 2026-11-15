import { compare } from "../money.js";
import type { Strategy } from "./strategy.js";

/**
 * What one strategy version changed against the one before it
 * (SPEC-notifications § Email design): the strategy email's subject and its
 * "What changed" list, and whether a version only reaffirmed the last one.
 */

type Thesis = Strategy["conviction"][number];

export interface StrategyChanges {
  added: { thesisId: string; symbol: string; weightPct: string }[];
  removed: { thesisId: string; symbol: string; weightPct: string }[];
  resized: { thesisId: string; symbol: string; from: string; to: string }[];
  /** A stop, review date or forecast moved on a thesis in both versions. */
  moved: { thesisId: string; symbol: string; field: "stop" | "review" | "forecast"; from: string | null; to: string | null }[];
  /** Anything else, in words: "TTMI's case", "the systematic sleeve", "the drift band". */
  edited: string[];
}

/** JSON with object keys sorted, so two documents compare by content whatever order their keys were stored in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Whether two documents are the same apart from their summaries: a version
 * that only reaffirms the last one. The weekly letter counts these instead of
 * listing them, and their activation goes to the digest, not an urgent email.
 */
export function sameExceptSummary(a: Record<string, unknown> | Strategy, b: Record<string, unknown> | Strategy): boolean {
  return canonical({ ...a, summary: undefined }) === canonical({ ...b, summary: undefined });
}

const forecastText = (t: Thesis): string | null => (t.forecast ? `${t.forecast.beatVtiPct}%` : null);

export function strategyChanges(prev: Strategy, next: Strategy): StrategyChanges {
  const before = new Map(prev.conviction.map((t) => [t.id, t]));
  const after = new Map(next.conviction.map((t) => [t.id, t]));
  const changes: StrategyChanges = { added: [], removed: [], resized: [], moved: [], edited: [] };

  for (const t of next.conviction) {
    const old = before.get(t.id);
    if (!old) {
      changes.added.push({ thesisId: t.id, symbol: t.symbol, weightPct: t.targetWeightPct });
      continue;
    }
    if (compare(old.targetWeightPct, t.targetWeightPct) !== 0) changes.resized.push({ thesisId: t.id, symbol: t.symbol, from: old.targetWeightPct, to: t.targetWeightPct });
    if (compare(old.stopLossPct, t.stopLossPct) !== 0) changes.moved.push({ thesisId: t.id, symbol: t.symbol, field: "stop", from: old.stopLossPct, to: t.stopLossPct });
    if ((old.reviewBy ?? null) !== (t.reviewBy ?? null)) changes.moved.push({ thesisId: t.id, symbol: t.symbol, field: "review", from: old.reviewBy ?? null, to: t.reviewBy ?? null });
    if (canonical(old.forecast ?? null) !== canonical(t.forecast ?? null)) {
      changes.moved.push({ thesisId: t.id, symbol: t.symbol, field: "forecast", from: forecastText(old), to: forecastText(t) });
    }
    const rest = (x: Thesis) => canonical({ ...x, targetWeightPct: undefined, stopLossPct: undefined, reviewBy: undefined, forecast: undefined });
    if (rest(old) !== rest(t)) changes.edited.push(`${t.symbol}'s case`);
  }
  for (const t of prev.conviction) {
    if (!after.has(t.id)) changes.removed.push({ thesisId: t.id, symbol: t.symbol, weightPct: t.targetWeightPct });
  }
  if (canonical(prev.systematic) !== canonical(next.systematic)) changes.edited.push("the systematic sleeve");
  if (canonical(prev.drift) !== canonical(next.drift)) changes.edited.push("the drift band");
  return changes;
}
