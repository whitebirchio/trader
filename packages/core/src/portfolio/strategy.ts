import { z } from "zod";
import { add, compare, decimalString } from "../money.js";

/**
 * The strategy document Claude (or the owner, for testing) submits
 * (SPEC-portfolio). Immutable once stored; every bound here is enforced
 * before a version can become active, and a rejected document leaves the
 * previous version in force. Error messages are written to be emailed.
 */

export const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const symbol = z.string().regex(SYMBOL, "must be an uppercase ticker like VTI or BRK.B");

/** A decimal string within [min, max] (inclusive unless `exclusiveMin`). */
function decimalIn(min: string, max: string, opts: { exclusiveMin?: boolean } = {}) {
  return decimalString.refine(
    (v) => (opts.exclusiveMin ? compare(v, min) > 0 : compare(v, min) >= 0) && compare(v, max) <= 0,
    { message: `must be ${opts.exclusiveMin ? "more than" : "at least"} ${min} and at most ${max}` },
  );
}

const intIn = (min: number, max: number) =>
  z.number().int("must be a whole number").min(min, `must be at least ${min}`).max(max, `must be at most ${max}`);

export const EVIDENCE_KINDS = ["congress", "insider", "13f", "fundamental", "news", "technical", "other"] as const;

const evidence = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  summary: z.string().trim().min(5, "needs a summary").max(1000),
  source: z.string().url("must be a URL").optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional(),
});

const thesis = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "must be a lowercase slug like aapl-services-2026q4"),
  symbol,
  targetWeightPct: decimalIn("0", "20", { exclusiveMin: true }),
  thesis: z.string().trim().min(20, "needs at least a sentence of reasoning").max(5000),
  evidence: z.array(evidence).min(1, "needs at least one piece of evidence").max(20),
  stopLossPct: decimalIn("5", "50"),
});

const systematic = z.object({
  universe: z.array(symbol).min(1, "needs at least one symbol").max(100, "can hold at most 100 symbols"),
  lookbackDays: intIn(21, 252),
  skipRecentDays: intIn(0, 21),
  topN: intIn(1, 20),
  trendFilterDays: intIn(50, 250).nullable(),
  weighting: z.enum(["equal", "inverse_volatility"]),
  volatilityDays: intIn(20, 126),
  defensive: symbol.nullable(),
});

export const strategySchema = z
  .object({
    summary: z.string().trim().min(1, "needs a summary").max(10_000),
    conviction: z.array(thesis).max(50),
    systematic,
    drift: z.object({ relativePct: decimalIn("1", "100"), minTradeUsd: decimalIn("1", "1000") }),
  })
  .superRefine((s, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

    const total = s.conviction.reduce((sum, t) => add(sum, t.targetWeightPct), "0");
    if (compare(total, "100") > 0) issue(["conviction"], `target weights add up to ${total}%, more than 100%`);

    const seenIds = new Set<string>();
    const seenSymbols = new Set<string>();
    s.conviction.forEach((t, i) => {
      if (seenIds.has(t.id)) issue(["conviction", i, "id"], `"${t.id}" is used by more than one thesis`);
      if (seenSymbols.has(t.symbol)) issue(["conviction", i, "symbol"], `${t.symbol} has more than one thesis`);
      seenIds.add(t.id);
      seenSymbols.add(t.symbol);
    });

    const universe = new Set(s.systematic.universe);
    if (universe.size !== s.systematic.universe.length) issue(["systematic", "universe"], "lists a symbol more than once");
    if (s.systematic.topN > universe.size) {
      issue(["systematic", "topN"], `asks for the top ${s.systematic.topN} of only ${universe.size} symbols`);
    }
    if (s.systematic.skipRecentDays >= s.systematic.lookbackDays) {
      issue(["systematic", "skipRecentDays"], "must be shorter than lookbackDays");
    }
    if (s.systematic.defensive && universe.has(s.systematic.defensive)) {
      issue(["systematic", "defensive"], `${s.systematic.defensive} can't be both in the universe and the defensive holding`);
    }
  });

export type Strategy = z.infer<typeof strategySchema>;
export type Thesis = Strategy["conviction"][number];
export type SystematicParams = Strategy["systematic"];

export type ValidationResult = { ok: true; strategy: Strategy } | { ok: false; errors: string[] };

/** Validate an untrusted document. Errors read like "conviction[1].stopLossPct: must be at least 5 and at most 50". */
export function validateStrategy(doc: unknown): ValidationResult {
  const parsed = strategySchema.safeParse(doc);
  if (parsed.success) return { ok: true, strategy: parsed.data };
  const errors = parsed.error.issues.map((i) => {
    const path = i.path
      .map((p, idx) => (typeof p === "number" ? `[${p}]` : idx === 0 ? String(p) : `.${String(p)}`))
      .join("");
    return path ? `${path}: ${i.message}` : i.message;
  });
  return { ok: false, errors };
}

/**
 * Before Claude's first strategy: the benchmark itself (SPEC-portfolio
 * resolved question 2). No theses; hold VTI.
 */
export const VERSION_0: Strategy = {
  summary: "Version 0: hold VTI (the benchmark) until Claude publishes a strategy.",
  conviction: [],
  systematic: {
    universe: ["VTI"],
    lookbackDays: 252,
    skipRecentDays: 21,
    topN: 1,
    trendFilterDays: null,
    weighting: "equal",
    volatilityDays: 63,
    defensive: null,
  },
  drift: { relativePct: "20", minTradeUsd: "5" },
};
