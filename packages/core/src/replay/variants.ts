import { compare } from "../money.js";
import { MAX_THESIS_WEIGHT_PCT } from "../portfolio/strategy.js";
import type { TimelineVersion } from "./driver.js";
import type { InsiderRule } from "./rules.js";

/**
 * Rule variants (#57 T7): a variant is a transform of a timeline's strategy
 * versions, so a baseline and its variant run on identical inputs and differ
 * only in what the variant names. For a rule-based timeline (T8) the same
 * change is made to the rule's parameters, and the timeline is written again.
 * Today's variants change the strategy; risk's limits are owner-set code,
 * and no variant touches them.
 *
 *   stop=N         every thesis's stop-loss at N% (5 to 50, as the schema allows)
 *   cap=N          every thesis's target weight capped at N%
 *   review-days=N  every thesis reviewed N days after the version that opened it
 *                  (an unwind unless a later version moves it on, which this
 *                  variant doesn't)
 *   trailing-stop=N  every thesis with a trailing stop N% below its high close
 *                    since entry (#35; 5 to 50)
 *   take-profit=N    every thesis sold whole N% above average cost (#35; 5 to 500)
 *
 * Documents are read leniently, like the scorecard reads them: a version
 * whose conviction list isn't an array passes through unchanged.
 */

export interface Variant {
  /** As given, e.g. "stop=20". */
  name: string;
  /** A recorded timeline's versions, transformed. */
  apply(versions: TimelineVersion[]): TimelineVersion[];
  /** The same change to a rule's parameters. */
  rule(rule: InsiderRule): InsiderRule;
}

type Thesis = Record<string, unknown>;
/** When each thesis id first appeared in the timeline. */
type Opened = (id: unknown) => Date | undefined;
interface Change {
  thesis: (t: Thesis, opened: Opened) => Thesis;
  rule: (r: InsiderRule) => InsiderRule;
}
type Kind = { describe: string; parse: (value: string) => Change };

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
      return { thesis: (t) => ({ ...t, stopLossPct: pct }), rule: (r) => ({ ...r, stopLossPct: pct }) };
    },
  },
  cap: {
    describe: "every thesis's target weight capped at N%",
    parse: (value) => {
      const pct = percent(value, "0.01", MAX_THESIS_WEIGHT_PCT, "cap");
      return {
        thesis: (t) => (typeof t.targetWeightPct === "string" && compare(t.targetWeightPct, pct) > 0 ? { ...t, targetWeightPct: pct } : t),
        rule: (r) => (compare(r.weightPct, pct) > 0 ? { ...r, weightPct: pct } : r),
      };
    },
  },
  "trailing-stop": {
    describe: "every thesis with a trailing stop N% below its high close since entry",
    parse: (value) => {
      const pct = percent(value, "5", "50", "trailing-stop");
      return { thesis: (t) => ({ ...t, trailingStopPct: pct }), rule: (r) => ({ ...r, trailingStopPct: pct }) };
    },
  },
  "take-profit": {
    describe: "every thesis sold whole N% above average cost",
    parse: (value) => {
      const pct = percent(value, "5", "500", "take-profit");
      return { thesis: (t) => ({ ...t, takeProfitPct: pct }), rule: (r) => ({ ...r, takeProfitPct: pct }) };
    },
  },
  "review-days": {
    describe: "every thesis reviewed N days after the version that opened it",
    parse: (value) => {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`review-days must be a whole number of days, got "${value}"`);
      const days = Number(value);
      return {
        thesis: (t, opened) => {
          const at = opened(t.id);
          return at ? { ...t, reviewBy: new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10) } : t;
        },
        rule: (r) => ({ ...r, reviewDays: days }),
      };
    },
  },
};

/** The variant kinds, for --help and errors. */
export const VARIANT_KINDS = Object.entries(KINDS).map(([k, v]) => `${k}=N: ${v.describe}`);

const conviction = (v: TimelineVersion): unknown[] | null => {
  const doc = v.document as { conviction?: unknown } | null;
  return doc && typeof doc === "object" && Array.isArray(doc.conviction) ? doc.conviction : null;
};

/** A variant from "kind=value". An unknown kind or a bad value is an error, never a silent baseline. */
export function parseVariant(spec: string): Variant {
  const [kind, value, ...rest] = spec.split("=");
  const k = kind ? KINDS[kind] : undefined;
  if (!k || value === undefined || rest.length) throw new Error(`unknown variant "${spec}"; expected one of: ${VARIANT_KINDS.join("; ")}`);
  const change = k.parse(value);
  return {
    name: spec,
    apply: (versions) => {
      const firstSeen = new Map<unknown, Date>();
      for (const v of [...versions].sort((a, b) => a.at.getTime() - b.at.getTime())) {
        for (const t of conviction(v) ?? []) {
          const id = (t as Thesis | null)?.id;
          if (id !== undefined && !firstSeen.has(id)) firstSeen.set(id, v.at);
        }
      }
      const opened: Opened = (id) => firstSeen.get(id);
      return versions.map((v) => {
        const list = conviction(v);
        if (!list) return v;
        return { ...v, document: { ...(v.document as object), conviction: list.map((t) => (t && typeof t === "object" ? change.thesis(t as Thesis, opened) : t)) } };
      });
    },
    rule: change.rule,
  };
}

/** Several variants applied in order, as one. */
export function combineVariants(variants: Variant[]): Variant {
  return {
    name: variants.map((v) => v.name).join(" + "),
    apply: (versions) => variants.reduce((vs, x) => x.apply(vs), versions),
    rule: (rule) => variants.reduce((r, x) => x.rule(r), rule),
  };
}
