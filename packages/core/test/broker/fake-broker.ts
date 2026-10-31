import type {
  Account,
  AccountConfig,
  Activity,
  Asset,
  Bar,
  BrokerAdapter,
  BrokerOrder,
  CalendarDay,
  Clock,
  OrderRequest,
  Position,
} from "../../src/broker/port.js";
import { BrokerHttpError } from "../../src/broker/port.js";

export const SAFE_CONFIG: AccountConfig = {
  maxMarginMultiplier: "1",
  noShorting: true,
  fractionalTrading: true,
  suspendTrade: false,
};

/** What the next submitOrder call does. */
export type SubmitBehaviour =
  | { kind: "accept"; status?: string }
  | { kind: "reject"; status: number; message: string }
  | { kind: "timeout" }
  | { kind: "accept_then_timeout" };

/**
 * In-memory BrokerAdapter for tests. State is public and mutable so a test can
 * script the broker's world (clock, account, fills) between calls, and every
 * call is counted so tests can assert that nothing was sent.
 */
export class FakeBroker implements BrokerAdapter {
  now = new Date("2026-11-02T15:00:00Z");
  clock: Omit<Clock, "timestamp"> = {
    isOpen: true,
    nextOpen: new Date("2026-11-03T14:30:00Z"),
    nextClose: new Date("2026-11-02T21:00:00Z"),
  };
  calendar: CalendarDay[] = [
    { date: "2026-11-02", open: new Date("2026-11-02T14:30:00Z"), close: new Date("2026-11-02T21:00:00Z") },
  ];
  account: Account = {
    accountNumber: "PA0000TEST",
    status: "ACTIVE",
    currency: "USD",
    cash: "1000",
    equity: "1000",
    lastEquity: "1000",
    longMarketValue: "0",
    buyingPower: "1000",
    multiplier: "1",
    tradingBlocked: false,
    accountBlocked: false,
    tradeSuspendedByUser: false,
  };
  config: AccountConfig = { ...SAFE_CONFIG };
  positions: Position[] = [];
  orders: BrokerOrder[] = [];
  activities: Activity[] = [];
  assets: Asset[] = [{ symbol: "VTI", name: "Vanguard Total Stock Market ETF", status: "active", tradable: true, fractionable: true }];
  bars: Record<string, Bar[]> = {};
  nextSubmit: SubmitBehaviour = { kind: "accept" };
  calls: Record<string, number> = {};

  private count(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  /** Helper: record a fill (and its position) as if Alpaca executed an order. */
  fill(orderId: string, symbol: string, side: "buy" | "sell", qty: string, price: string, at = this.now): void {
    this.activities.push({
      id: `${at.toISOString()}::${orderId}`,
      type: "FILL",
      at,
      symbol,
      side,
      qty,
      price,
      netAmount: null,
      orderId,
      raw: {},
    });
  }

  async getAccount() {
    this.count("getAccount");
    return { ...this.account };
  }
  async getAccountConfig() {
    this.count("getAccountConfig");
    return { ...this.config };
  }
  async updateAccountConfig(patch: Partial<AccountConfig>) {
    this.count("updateAccountConfig");
    this.config = { ...this.config, ...patch };
    return { ...this.config };
  }
  async getClock() {
    this.count("getClock");
    return { ...this.clock, timestamp: this.now };
  }
  async getCalendar(start: string, end: string) {
    this.count("getCalendar");
    return this.calendar.filter((d) => d.date >= start && d.date <= end);
  }
  async getPositions() {
    this.count("getPositions");
    return this.positions.map((p) => ({ ...p }));
  }
  async getOrders(after: Date) {
    this.count("getOrders");
    return this.orders.filter((o) => o.createdAt > after).map((o) => ({ ...o }));
  }
  async getOrderByClientId(clientOrderId: string) {
    this.count("getOrderByClientId");
    const o = this.orders.find((x) => x.clientOrderId === clientOrderId);
    return o ? { ...o } : null;
  }
  async submitOrder(request: OrderRequest) {
    this.count("submitOrder");
    const behaviour = this.nextSubmit;
    if (behaviour.kind === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (behaviour.kind === "reject") {
      throw new BrokerHttpError(behaviour.status, 40310000, `POST /v2/orders: ${behaviour.message}`);
    }
    if (this.orders.some((o) => o.clientOrderId === request.clientOrderId)) {
      throw new BrokerHttpError(422, 40010001, "POST /v2/orders: client_order_id must be unique");
    }
    const order: BrokerOrder = {
      id: `order-${this.orders.length + 1}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      notional: request.notional ?? null,
      qty: request.qty ?? null,
      filledQty: "0",
      filledAvgPrice: null,
      status: behaviour.kind === "accept" && behaviour.status ? behaviour.status : "accepted",
      createdAt: this.now,
      updatedAt: this.now,
      submittedAt: this.now,
      raw: {},
    };
    this.orders.push(order);
    if (behaviour.kind === "accept_then_timeout") {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    return { ...order };
  }
  async getActivities(after?: Date) {
    this.count("getActivities");
    return this.activities.filter((a) => !after || a.at > after).map((a) => ({ ...a }));
  }
  async getAsset(symbol: string) {
    this.count("getAsset");
    return this.assets.find((a) => a.symbol === symbol) ?? null;
  }
  async getDailyBars(symbols: string[]) {
    this.count("getDailyBars");
    return Object.fromEntries(symbols.map((s) => [s, this.bars[s] ?? []]));
  }
}
