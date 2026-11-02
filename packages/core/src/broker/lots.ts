import { add, compare, div, mul, sub } from "../money.js";
import type { Activity } from "./port.js";

/**
 * Tax lots rebuilt from fills, first-in first-out: the method Alpaca reportedly
 * uses for 1099s, and the API offers no lot selection. Recomputed from the
 * activity log on every sync rather than stored, so a correction to the
 * activities fixes the lots automatically.
 */

export interface OpenLot {
  symbol: string;
  qty: string;
  costBasis: string;
  openedAt: Date;
  activityId: string;
}

/** A sold slice of one lot. Gains and dates are what wash-sale checks need (ADR-010). */
export interface ClosedLot {
  symbol: string;
  qty: string;
  costBasis: string;
  proceeds: string;
  gain: string;
  openedAt: Date;
  closedAt: Date;
}

export interface LotIssue {
  symbol: string;
  reason: string;
}

export interface Lots {
  open: OpenLot[];
  closed: ClosedLot[];
  /** Anything the FIFO model can't account for. A symbol with an issue must not trade. */
  issues: LotIssue[];
}

/**
 * Activity types that change share counts without a FILL: splits, spinoffs,
 * symbol changes, mergers, reorganizations, transfers in or out, name changes,
 * option events. Their shapes vary, so v1 refuses to guess and reports them.
 */
const SHARE_AFFECTING = new Set(["SSP", "SSO", "SC", "MA", "REORG", "ACATC", "ACATS", "NC", "OPASN", "OPEXP", "OPXRC"]);

// Basis is allocated to a partial sale at this precision; the remainder stays
// on the lot, so basis is never created or lost across slices.
const BASIS_DP = 11;

export function buildLots(activities: Activity[]): Lots {
  const sorted = [...activities].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
  );
  const queues = new Map<string, OpenLot[]>();
  const closed: ClosedLot[] = [];
  const issues: LotIssue[] = [];

  for (const a of sorted) {
    if (a.type !== "FILL") {
      if (a.symbol && SHARE_AFFECTING.has(a.type)) {
        issues.push({ symbol: a.symbol, reason: `unsupported share-affecting activity ${a.type}` });
      }
      continue;
    }
    if (!a.symbol || !a.side || !a.qty || !a.price) {
      issues.push({ symbol: a.symbol ?? "?", reason: `malformed fill ${a.id}` });
      continue;
    }
    const queue = queues.get(a.symbol) ?? [];
    queues.set(a.symbol, queue);

    if (a.side === "buy") {
      queue.push({ symbol: a.symbol, qty: a.qty, costBasis: mul(a.qty, a.price), openedAt: a.at, activityId: a.id });
      continue;
    }

    let remaining = a.qty;
    while (compare(remaining, "0") > 0) {
      const lot = queue[0];
      if (!lot) {
        issues.push({ symbol: a.symbol, reason: `sell exceeds known lots by ${remaining} shares` });
        break;
      }
      const take = compare(remaining, lot.qty) < 0 ? remaining : lot.qty;
      const whole = compare(take, lot.qty) === 0;
      const basis = whole ? lot.costBasis : div(mul(lot.costBasis, take), lot.qty, BASIS_DP, "half-even");
      const proceeds = mul(take, a.price);
      closed.push({
        symbol: a.symbol,
        qty: take,
        costBasis: basis,
        proceeds,
        gain: sub(proceeds, basis),
        openedAt: lot.openedAt,
        closedAt: a.at,
      });
      if (whole) queue.shift();
      else {
        lot.qty = sub(lot.qty, take);
        lot.costBasis = sub(lot.costBasis, basis);
      }
      remaining = sub(remaining, take);
    }
  }

  const open = [...queues.values()].flat();
  return { open, closed, issues };
}

/** Open quantity per symbol, for reconciliation against broker positions. */
export function openQtyBySymbol(lots: OpenLot[]): Map<string, string> {
  const totals = new Map<string, string>();
  for (const lot of lots) totals.set(lot.symbol, add(totals.get(lot.symbol) ?? "0", lot.qty));
  return totals;
}

/** What selling `qty` now would realize, first-in first-out: the tax view of a planned sell. */
export interface SaleEstimate {
  proceeds: string;
  costBasis: string;
  gain: string;
  /** Lots held a year or less. */
  shortTermGain: string;
  /** Lots held more than a year. */
  longTermGain: string;
  /** The newest lot sold, for wash-sale checks. */
  latestLotOpenedAt: Date | null;
}

/** More than one year, by calendar date: the IRS long-term holding period. */
export function isLongTerm(openedAt: Date, soldAt: Date): boolean {
  const anniversary = new Date(openedAt);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  return soldAt > anniversary;
}

/** Pure: the FIFO lots a sell of `qty` at `price` would close. Shares beyond the known lots have no basis and aren't counted. */
export function estimateSale(open: OpenLot[], symbol: string, qty: string, price: string, at: Date): SaleEstimate {
  const queue = open.filter((l) => l.symbol === symbol).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.activityId.localeCompare(b.activityId));
  let remaining = qty;
  const out: SaleEstimate = { proceeds: "0", costBasis: "0", gain: "0", shortTermGain: "0", longTermGain: "0", latestLotOpenedAt: null };
  for (const lot of queue) {
    if (compare(remaining, "0") <= 0) break;
    const take = compare(remaining, lot.qty) < 0 ? remaining : lot.qty;
    const basis = compare(take, lot.qty) === 0 ? lot.costBasis : div(mul(lot.costBasis, take), lot.qty, BASIS_DP, "half-even");
    const proceeds = mul(take, price);
    const gain = sub(proceeds, basis);
    out.proceeds = add(out.proceeds, proceeds);
    out.costBasis = add(out.costBasis, basis);
    out.gain = add(out.gain, gain);
    if (isLongTerm(lot.openedAt, at)) out.longTermGain = add(out.longTermGain, gain);
    else out.shortTermGain = add(out.shortTermGain, gain);
    out.latestLotOpenedAt = lot.openedAt;
    remaining = sub(remaining, take);
  }
  return out;
}
