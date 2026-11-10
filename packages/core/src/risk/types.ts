import type { OrderSide } from "../broker/port.js";
import type { WithdrawalReserve } from "./reserve.js";

export type Sleeve = "systematic" | "conviction";

/**
 * A proposed order from `portfolio`. Buys are sized in dollars and sells in
 * shares: a sell's exact share count is what the no-shorting rule checks.
 */
export type Proposal = {
  key: string;
  symbol: string;
  sleeve: Sleeve;
  /**
   * What a drawdown halt lets through (ADR-017):
   * - `withdrawal`: a sell raising cash for the owner's withdrawal, only up to
   *   what it still needs (SPEC-capital decision 2);
   * - `exit`: a whole single-stock position sold because its thesis closed
   *   (stopped, stale, overdue) or left the strategy. Never a broad ETF.
   */
  purpose?: "withdrawal" | "exit";
} & ({ side: Extract<OrderSide, "buy">; notional: string } | { side: Extract<OrderSide, "sell">; qty: string });

export interface Holding {
  symbol: string;
  qty: string;
  marketValue: string;
  /** Unattributed holdings count as conviction: the conservative side of the cap. */
  sleeve: Sleeve;
}

/** What the eligibility rules need to know about a symbol. Null means "couldn't find out". */
export interface AssetFacts {
  symbol: string;
  name: string;
  tradable: boolean;
  fractionable: boolean;
  lastClose: string | null;
  avgDollarVolume: string | null;
  /** Calendar days since the first daily bar we could find (bars are fetched 120 days back). */
  historyDays: number | null;
}

export interface RiskSnapshot {
  now: Date;
  equity: string;
  cash: string;
  holdings: Holding[];
  /** `drawdownPct` is measured from the owner's last resume while `rebased` is set (ADR-017). */
  index: { drawdownPct: string; dailyChangePct: string; rebased?: { resumedAt: Date; prePeakDrawdownPct: string } };
  broker: { tradingAllowed: boolean; blockedReasons: string[]; syncedAt: Date | null };
  state: { killSwitch: boolean; killReason: string | null; halted: boolean; haltReason: string | null };
  /**
   * Orders already placed today (any status), and their buy notional. `bought`
   * and `sold`: symbols traded today on each side (fills, plus orders that may
   * still fill), for the same-day round-trip guard.
   */
  today: { orderCount: number; buyNotional: string; bought: string[]; sold: string[] };
  /** Cash held for an open withdrawal request (SPEC-capital): buys may not touch it. */
  withdrawal: WithdrawalReserve;
  assets: Record<string, AssetFacts>;
}

export type Verdict = "approved" | "clipped" | "rejected";

export interface Decision {
  proposal: Proposal;
  verdict: Verdict;
  /** The approved size: notional for buys, qty for sells. Absent when rejected. */
  notional?: string;
  qty?: string;
  /** Human-readable, email-ready. Empty for a clean approval. */
  reasons: string[];
}
