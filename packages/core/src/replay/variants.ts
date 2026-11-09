import { compare } from "../money.js";
import { MAX_THESIS_WEIGHT_PCT } from "../portfolio/strategy.js";
import type { TimelineVersion } from "./driver.js";

/**
 * Rule variants (#57 T7): a variant is a transform of every strategy version
 * in a timeline, so a baseline and its variant run on identical inputs and
 * differ only in what the variant names. Today's variants change the
 * strategy document; risk's limits are owner-set code, and no variant
 * touches them.
 *
 *   stop=N         every thesis's stop-loss at N% (5 to 50, as the schema allows)
 *   cap=N          every thesis's target weight capped at N%
 *   review-days=N  every thesis reviewed N days after its version (an unwind if not resubmitted by then)
 *
 * Documents are read leniently, like the scorecard reads them: a version
 * whose conviction list isn't an array passes through unchanged.
 */

export interface Variant {
  /** As given, e.g. "stop=20". */
  name: string;
  apply(version: TimelineVersion): TimelineVersion;
}

type Thesis = Record<string, unknown>;
type Kind = { describe: string; parse: (value: string) => (thesis: Thesis, version: TimelineVersion) => Thesis };

const DAY_MS = 86_400_000;
const decimal = /^\d+(\.\d+)?$/;

function percent(value: string, min: string, max: string, what: string): string {
  if (!decimal.test(value) || compare(value, min) < 0 || compare(value, max) > 0) throw new Error(`${what} must be a percentage from ${min} to ${max}, got "${value}"`);
  return value;
}

const KINDS: Record<string, Kind> = {
  stop: {
    describe: "every thesis's stop-loss at N%",
    parse: (value) => {
      const pct = percent(value, "5", "50", "stop");
      return (t) => ({ ...t, stopLossPct: pct });
    },
  },
  cap: {
    describe: "every thesis's target weight capped at N%",
    parse: (value) => {
      const pct = percent(value, "0.01", MAX_THESIS_WEIGHT_PCT, "cap");
      return (t) => (typeof t.targetWeightPct === "string" && compare(t.targetWeightPct, pct) > 0 ? { ...t, targetWeightPct: pct } : t);
    },
  },
  "review-days": {
    describe: "every thesis reviewed N days after its version",
    parse: (value) => {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`review-days must be a whole number of days, got "${value}"`);
      const days = Number(value);
      return (t, v) => ({ ...t, reviewBy: new Date(v.at.getTime() + days * DAY_MS).toISOString().slice(0, 10) });
    },
  },
};

/** The variant kinds, for --help and errors. */
export const VARIANT_KINDS = Object.entries(KINDS).map(([k, v]) => `${k}=N: ${v.describe}`);

/** A variant from "kind=value". An unknown kind or a bad value is an error, never a silent baseline. */
export function parseVariant(spec: string): Variant {
  const [kind, value, ...rest] = spec.split("=");
  const k = kind ? KINDS[kind] : undefined;
  if (!k || value === undefined || rest.length) throw new Error(`unknown variant "${spec}"; expected one of: ${VARIANT_KINDS.join("; ")}`);
  const change = k.parse(value);
  return {
    name: spec,
    apply: (v) => {
      const doc = v.document as { conviction?: unknown } | null;
      if (!doc || typeof doc !== "object" || !Array.isArray(doc.conviction)) return v;
      return { ...v, document: { ...doc, conviction: doc.conviction.map((t) => (t && typeof t === "object" ? change(t as Thesis, v) : t)) } };
    },
  };
}

/** Several variants applied in order, as one. */
export function combineVariants(variants: Variant[]): Variant {
  return { name: variants.map((v) => v.name).join(" + "), apply: (version) => variants.reduce((v, x) => x.apply(v), version) };
}
