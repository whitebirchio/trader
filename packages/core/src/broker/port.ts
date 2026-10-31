/**
 * The broker port (ADR-002): what the rest of core needs from a brokerage,
 * in our own types. Every money/quantity field is a decimal string (ADR-009).
 * `AlpacaBroker` implements it over HTTP; tests use an in-memory fake.
 */

export interface Account {
  accountNumber: string;
  status: string;
  currency: string;
  cash: string;
  equity: string;
  lastEquity: string;
  longMarketValue: string;
  buyingPower: string;
  multiplier: string;
  tradingBlocked: boolean;
  accountBlocked: boolean;
  tradeSuspendedByUser: boolean;
}

export interface AccountConfig {
  maxMarginMultiplier: string;
  noShorting: boolean;
  fractionalTrading: boolean;
  suspendTrade: boolean;
}

export interface Clock {
  timestamp: Date;
  isOpen: boolean;
  nextOpen: Date;
  nextClose: Date;
}

/** One trading session. `open`/`close` are absolute instants (converted from New York time). */
export interface CalendarDay {
  date: string;
  open: Date;
  close: Date;
}

export interface Position {
  symbol: string;
  qty: string;
  avgEntryPrice: string;
  marketValue: string;
  costBasis: string;
  currentPrice: string;
}

export type OrderSide = "buy" | "sell";

export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  notional: string | null;
  qty: string | null;
  filledQty: string;
  filledAvgPrice: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  raw: Record<string, unknown>;
}

/** Market, day, regular hours only (SPEC-broker assumption 2). Exactly one of notional/qty. */
export type OrderRequest = {
  symbol: string;
  side: OrderSide;
  clientOrderId: string;
} & ({ notional: string; qty?: never } | { qty: string; notional?: never });

export interface Activity {
  id: string;
  /** Alpaca activity_type: FILL, DIV, FEE, CSD, JNLC, SSP, … */
  type: string;
  at: Date;
  symbol: string | null;
  side: OrderSide | null;
  qty: string | null;
  price: string | null;
  netAmount: string | null;
  orderId: string | null;
  raw: Record<string, unknown>;
}

export interface Asset {
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  fractionable: boolean;
}

export interface Bar {
  t: Date;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface BrokerAdapter {
  getAccount(): Promise<Account>;
  getAccountConfig(): Promise<AccountConfig>;
  updateAccountConfig(patch: Partial<AccountConfig>): Promise<AccountConfig>;
  getClock(): Promise<Clock>;
  getCalendar(start: string, end: string): Promise<CalendarDay[]>;
  getPositions(): Promise<Position[]>;
  /** All orders (any status) created after `after`, oldest first. */
  getOrders(after: Date): Promise<BrokerOrder[]>;
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;
  submitOrder(request: OrderRequest): Promise<BrokerOrder>;
  /** All activities after `after` (or the whole history), oldest first, every page. */
  getActivities(after?: Date): Promise<Activity[]>;
  getAsset(symbol: string): Promise<Asset | null>;
  /** Split- and dividend-adjusted daily bars per symbol, oldest first. */
  getDailyBars(symbols: string[], start: Date, end: Date): Promise<Record<string, Bar[]>>;
}

/** An HTTP-level failure from the broker. Never carries credentials. */
export class BrokerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "BrokerHttpError";
  }
}
