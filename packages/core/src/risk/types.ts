import type { OrderSide } from "../broker/port.js";

export type Sleeve = "core" | "satellite";

/**
 * A proposed order from `portfolio`. Buys are sized in dollars and sells in
 * shares: a sell's exact share count is what the no-shorting rule checks.
 */
export type Proposal = {
  key: string;
  symbol: string;
  sleeve: Sleeve;
} & ({ side: Extract<OrderSide, "buy">; notional: string } | { side: Extract<OrderSide, "sell">; qty: string });

export interface Holding {
  symbol: string;
  qty: string;
  marketValue: string;
  /** Unattributed holdings count as satellite: the conservative side of the cap. */
  sleeve: Sleeve;
}

/** What the eligibility rules need to know about a symbol. Null means "couldn't find out". */
export interface AssetFacts {
  symbol: string;
  name: string;
  tradable: boolean;
  fractionable: boolean;
  marginRequirementLong: string | null;
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
  index: { drawdownPct: string; dailyChangePct: string };
  broker: { tradingAllowed: boolean; blockedReasons: string[]; syncedAt: Date | null };
  state: { killSwitch: boolean; killReason: string | null; halted: boolean; haltReason: string | null };
  /** Orders already placed today (any status), and their buy notional. */
  today: { orderCount: number; buyNotional: string };
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
