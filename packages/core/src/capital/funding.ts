import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brokerAccount, positions } from "../db/schema.js";
import { add, compare, div, mul, round, sub } from "../money.js";
import { activeStrategy, stoppedThesisIds, submitStrategy } from "../portfolio/store.js";
import { MAX_THESIS_WEIGHT_PCT, type Strategy } from "../portfolio/strategy.js";
import { LIMITS, type Limits } from "../risk/limits.js";
import { loadReserve } from "../risk/reserve.js";

/**
 * The fallback funding plan (SPEC-capital decision 1): when Claude doesn't
 * plan a withdrawal in time, or Scott asks to fund it now. Every thesis keeps
 * its dollars, so its weight grows as the account shrinks; VTI and the
 * systematic sleeve absorb the withdrawal. Theses are trimmed only when
 * they're worth more than what stays invested.
 */

const WEIGHT_DP = 4;
/** The smallest weight a thesis can carry (the schema needs more than 0). */
const MIN_WEIGHT = "0.0001";

export interface FallbackInput {
  active: Strategy;
  /** Market value of each held symbol. */
  values: Record<string, string>;
  equity: string;
  /** Withdrawal dollars still to come out. */
  outstanding: string;
  stoppedIds: ReadonlySet<string>;
  /** Why the fallback is running, for the summary (email-ready). */
  why: string;
  limits: Limits;
}

const usd = (v: string) => `$${round(v, 2, "down")}`;
const pctOf = (v: string, pct: string) => div(mul(v, pct), "100", 6, "down");

/** The active strategy re-weighted to keep thesis dollars after the withdrawal. Pure. */
export function fallbackStrategy(input: FallbackInput): Strategy {
  const { active, limits } = input;
  const buffer = compare(limits.cashBufferMin, pctOf(input.equity, limits.cashBufferPct)) >= 0 ? limits.cashBufferMin : pctOf(input.equity, limits.cashBufferPct);
  const investableBefore = compare(input.equity, buffer) > 0 ? sub(input.equity, buffer) : "0";
  const after = sub(investableBefore, input.outstanding);
  const theses = active.conviction.filter((t) => !input.stoppedIds.has(t.id));
  const head = `Fallback funding for a ${usd(input.outstanding)} withdrawal: ${input.why}.`;
  if (compare(after, "0") <= 0 || theses.length === 0) {
    return { ...active, conviction: theses, summary: `${head} Nothing stays invested, so the weights are unchanged.\n\n${active.summary}` };
  }

  // A held thesis keeps its market value; one not bought yet keeps its planned dollars.
  const dollars = theses.map((t) => input.values[t.symbol] ?? pctOf(investableBefore, t.targetWeightPct));
  const total = dollars.reduce((sum, d) => add(sum, d), "0");
  const trimmed = compare(total, after) > 0;
  const lines: string[] = [];
  const conviction = theses.map((t, i) => {
    const kept = trimmed ? div(mul(dollars[i]!, after), total, 6, "down") : dollars[i]!;
    let weight = round(div(mul(kept, "100"), after, 10, "down"), WEIGHT_DP, "down");
    if (compare(weight, MAX_THESIS_WEIGHT_PCT) > 0) {
      weight = MAX_THESIS_WEIGHT_PCT;
      lines.push(`${t.symbol} goes from ${usd(dollars[i]!)} to ${usd(pctOf(after, weight))} (the ${MAX_THESIS_WEIGHT_PCT}% thesis limit)`);
    } else {
      if (compare(weight, MIN_WEIGHT) < 0) weight = MIN_WEIGHT;
      lines.push(trimmed ? `${t.symbol} trimmed to ${usd(kept)} (${weight}%)` : `${t.symbol} keeps ${usd(kept)} (${weight}% of what stays invested)`);
    }
    return { ...t, targetWeightPct: weight };
  });

  const body = [
    trimmed
      ? `The theses (${usd(total)}) are worth more than the ${usd(after)} that stays invested, so each is trimmed pro rata.`
      : "Each thesis keeps its dollars; VTI and the systematic sleeve give up the rest.",
    ...lines.map((l) => `• ${l}`),
  ].join("\n");
  return { ...active, conviction, summary: `${head} ${body}\n\nClaude's last summary:\n${active.summary}`.slice(0, 10_000) };
}

/**
 * Build the fallback from the database and store it as a `system` version:
 * the first version after the request, so the request moves to funding. If
 * the re-weighted document were ever rejected, the active one is resubmitted
 * as it is: a smaller account shrinks every target pro rata anyway.
 */
export async function fundWithFallback(db: Db, why: string, now: Date, limits: Limits = LIMITS): Promise<number> {
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  if (!account) throw new Error("the broker has never been synced");
  const active = await activeStrategy(db, now);
  const held = await db.select({ symbol: positions.symbol, marketValue: positions.marketValue }).from(positions);
  const reserve = await loadReserve(db, account.equity, account.cash);
  const doc = fallbackStrategy({
    active: active.strategy,
    values: Object.fromEntries(held.map((p) => [p.symbol, p.marketValue])),
    equity: account.equity,
    outstanding: reserve.outstanding,
    stoppedIds: await stoppedThesisIds(db),
    why,
    limits,
  });
  const result = await submitStrategy(db, doc, "system", now);
  if (result.status === "activated") return result.version;
  const unchanged = await submitStrategy(db, { ...active.strategy, summary: `Fallback funding (${why}); the active strategy, unchanged.\n\n${active.strategy.summary}`.slice(0, 10_000) }, "system", now);
  if (unchanged.status === "activated") return unchanged.version;
  throw new Error(`fallback funding was rejected: ${unchanged.errors.join("; ")}`);
}
