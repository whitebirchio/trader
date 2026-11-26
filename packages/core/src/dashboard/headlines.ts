/**
 * The one-line headline the dashboard leads with (SPEC-dashboard Amendment 3):
 * the routine's `headline`, or, until a run adds one, the first sentence of
 * the plain summary (or the reasoning), marked as a fallback. Pure.
 */
import type { Thesis } from "../portfolio/strategy.js";

export interface Headline {
  text: string;
  /** True when it's the summary's first sentence, not a headline the routine wrote. */
  fallback: boolean;
}

const MAX = 160;

/** The first sentence of `text`, cut at a word near MAX characters if there's no sentence break. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  if (sentence.length <= MAX) return sentence;
  const cut = sentence.slice(0, MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), MAX - 20))}…`;
}

export function headlineOf(t: Pick<Thesis, "headline" | "plainSummary" | "thesis">): Headline {
  if (t.headline) return { text: t.headline, fallback: false };
  return { text: firstSentence(t.plainSummary ?? t.thesis), fallback: true };
}
