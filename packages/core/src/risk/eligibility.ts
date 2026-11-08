import type { Asset, Bar } from "../broker/port.js";
import { add, compare, div, mul } from "../money.js";
import type { Limits } from "./limits.js";
import type { AssetFacts } from "./types.js";

/**
 * Fund-name markers of leveraged, inverse or volatility products. "Short"
 * counts unless it means duration (Short-Term / Short Duration / Short
 * Maturity). False positives are acceptable here; false negatives are not
 * (SPEC-risk).
 */
const LEVERAGED_NAME = /\b(ultra\w*|bull|bear|inverse|leveraged|\d+(\.\d+)?x|vix|volatility)\b/i;
const SHORT_NAME = /\bshort\b(?![\s-]*(term|duration|maturity))/i;

/** Why a symbol may not be bought; empty when eligible. Sells never consult this. */
export function ineligibleReasons(symbol: string, facts: AssetFacts | undefined, limits: Limits): string[] {
  if (!facts) return [`Couldn't verify ${symbol}'s eligibility (no asset data).`];
  const reasons: string[] = [];

  if (!facts.tradable) reasons.push(`${symbol} isn't tradable at Alpaca.`);
  if (!facts.fractionable) reasons.push(`${symbol} can't be traded in fractional shares.`);

  // Two independent layers (SPEC-risk): the sponsor, then the fund's own name.
  const sponsor = limits.leveragedFundSponsors.find((sp) => new RegExp(`\\b${sp}\\b`, "i").test(facts.name));
  if (sponsor) {
    reasons.push(`${symbol} is leveraged or inverse: ${sponsor} makes leveraged, inverse and volatility funds ("${facts.name}").`);
  }
  if (LEVERAGED_NAME.test(facts.name) || SHORT_NAME.test(facts.name)) {
    reasons.push(`${symbol} looks leveraged or inverse by name ("${facts.name}").`);
  }

  if (facts.lastClose === null) reasons.push(`Couldn't verify ${symbol}'s price (no recent bars).`);
  else if (compare(facts.lastClose, limits.minPrice) < 0) {
    reasons.push(`${symbol} trades under $${limits.minPrice} ($${facts.lastClose}).`);
  }

  if (facts.avgDollarVolume === null) reasons.push(`Couldn't verify ${symbol}'s trading volume.`);
  else if (compare(facts.avgDollarVolume, limits.minAvgDollarVolume) < 0) {
    reasons.push(`${symbol} is illiquid (about $${facts.avgDollarVolume} traded per day; minimum $${limits.minAvgDollarVolume}).`);
  }

  if (facts.historyDays === null) reasons.push(`Couldn't verify how long ${symbol} has traded.`);
  else if (facts.historyDays < limits.minHistoryDays) {
    reasons.push(`${symbol} has only ${facts.historyDays} days of trading history (minimum ${limits.minHistoryDays}).`);
  }

  // One leveraged/inverse finding is enough; don't say it twice.
  const leveraged = reasons.filter((r) => r.includes("leveraged or inverse"));
  return leveraged.length > 1 ? reasons.filter((r) => r !== leveraged[1]) : reasons;
}

/**
 * Build AssetFacts from an asset record and its daily bars (oldest first).
 * Pure; `riskGate` does the fetching. Average dollar volume uses the last
 * `avgDollarVolumeDays` bars at close × volume.
 */
export function assetFacts(
  symbol: string,
  asset: Asset | null,
  bars: Bar[],
  now: Date,
  limits: Limits,
): AssetFacts | undefined {
  if (!asset) return undefined;
  const recent = bars.slice(-limits.avgDollarVolumeDays);
  const first = bars[0];
  const last = bars.at(-1);
  let total = "0";
  for (const b of recent) total = add(total, mul(b.c, b.v));
  return {
    symbol,
    name: asset.name,
    tradable: asset.tradable && asset.status === "active",
    fractionable: asset.fractionable,
    lastClose: last?.c ?? null,
    avgDollarVolume: recent.length > 0 ? div(total, String(recent.length), 0, "down") : null,
    historyDays: first ? Math.floor((now.getTime() - first.t.getTime()) / 86_400_000) : null,
  };
}
