import { add, compare, div, mul, round, sub } from "../money.js";
import { marketDate } from "../time.js";
import {
  type Account,
  type AccountConfig,
  type Activity,
  type Asset,
  type Bar,
  type BrokerAdapter,
  BrokerHttpError,
  type BrokerOrder,
  type CalendarDay,
  type Clock,
  type OrderRequest,
  type Position,
} from "../broker/port.js";

/**
 * A simulated broker over historical daily bars, for the replay (#57,
 * tasks/replay-plan.md). The real sync, rebalance, risk and order code runs
 * against it unchanged, with `now` moved forward by the driver.
 *
 * No lookahead: before a session opens, a symbol's price is its last close;
 * from the open it's the session's open, and getDailyBars reports today's bar
 * as partial (open = high = low = close = the open); only after the close
 * does the full bar appear. An order fills at the open of the session it was
 * placed in (or the next one, if placed outside a session), plus slippage
 * against the trader. It refuses what Alpaca would: selling more than is held,
 * or buying with more than the cash.
 */

export interface SimMarket {
  /** Adjusted daily bars per symbol, oldest first, as decimal strings. */
  bars: Record<string, Bar[]>;
  /** Trading sessions, oldest first. */
  calendar: CalendarDay[];
  assets: Record<string, Asset>;
}

export interface SimOptions {
  /** Starting cash. */
  cash: string;
  /** Slippage in basis points, paid on every fill (buys fill higher, sells lower). Default 10 (0.10%). */
  slippageBps?: number;
  /** The simulation's starting instant. */
  now: Date;
}

const SIM_CONFIG: AccountConfig = { maxMarginMultiplier: "1", noShorting: true, fractionalTrading: true, suspendTrade: false };

interface Holding {
  qty: string;
  costBasis: string;
}

export class SimBroker implements BrokerAdapter {
  now: Date;
  private cash: string;
  private readonly slippage: string;
  private readonly holdings = new Map<string, Holding>();
  private readonly orders: BrokerOrder[] = [];
  private readonly activities: Activity[] = [];
  private readonly barsByDate: Record<string, Map<string, Bar>>;
  private seq = 0;

  constructor(
    private readonly market: SimMarket,
    options: SimOptions,
  ) {
    this.now = options.now;
    this.cash = options.cash;
    this.slippage = div(String(options.slippageBps ?? 10), "10000", 6, "half-even");
    this.barsByDate = Object.fromEntries(Object.entries(market.bars).map(([s, bars]) => [s, new Map(bars.map((b) => [marketDate(b.t), b]))]));
  }

  // --- The simulation's own controls (not part of BrokerAdapter) ----------------

  /** Move the clock. Orders waiting for a session that has now opened are filled. */
  setNow(now: Date): void {
    this.now = now;
    this.settle();
  }

  /** Money arrives in the account now, as Alpaca records a deposit (an activity the ledger books). */
  deposit(amount: string): void {
    this.settle();
    this.cash = add(this.cash, amount);
    this.activities.push({ id: this.nextId("csd"), type: "CSD", at: this.now, symbol: null, side: null, qty: null, price: null, netAmount: amount, orderId: null, raw: { status: "executed", created_at: this.now.toISOString() } });
  }

  // --- Prices -------------------------------------------------------------------

  private session(date: string): CalendarDay | undefined {
    return this.market.calendar.find((d) => d.date === date);
  }

  /** The price a symbol trades at now: today's open during the session, else the latest close. */
  priceNow(symbol: string): string | null {
    const today = marketDate(this.now);
    const session = this.session(today);
    const todays = this.barsByDate[symbol]?.get(today);
    if (session && todays && this.now >= session.open) return this.now >= session.close ? todays.c : todays.o;
    const before = (this.market.bars[symbol] ?? []).filter((b) => marketDate(b.t) < today).at(-1);
    return before?.c ?? null;
  }

  /** The close of the last session before today (what equity is measured against). */
  private lastClose(symbol: string): string | null {
    const today = marketDate(this.now);
    return (this.market.bars[symbol] ?? []).filter((b) => marketDate(b.t) < today).at(-1)?.c ?? null;
  }

  // --- Orders and fills ---------------------------------------------------------

  private nextId(prefix: string): string {
    this.seq++;
    return `sim-${prefix}-${this.seq}`;
  }

  /** The session an order placed at `at` fills in: the first one that hasn't closed yet (the current one, or the next). */
  private fillSession(at: Date): CalendarDay | undefined {
    return this.market.calendar.find((d) => d.close > at);
  }

  /** Fill every accepted order whose session has opened. */
  private settle(): void {
    for (const order of this.orders) {
      if (order.status !== "accepted") continue;
      const session = this.fillSession(order.createdAt);
      if (!session || this.now < session.open) continue;
      this.fill(order, session);
    }
  }

  private fill(order: BrokerOrder, session: CalendarDay): void {
    const bar = this.barsByDate[order.symbol]?.get(session.date);
    if (!bar) {
      // No trading in the symbol that session (halted, delisted): Alpaca would cancel the day order.
      order.status = "canceled";
      order.updatedAt = session.close;
      return;
    }
    // At the session's open price, timestamped no earlier than the order itself.
    const at = order.createdAt > session.open ? order.createdAt : session.open;
    const price = order.side === "buy" ? mul(bar.o, add("1", this.slippage)) : mul(bar.o, sub("1", this.slippage));
    const fillPrice = round(price, 4, "half-even");
    const held = this.holdings.get(order.symbol) ?? { qty: "0", costBasis: "0" };
    let qty: string;
    if (order.side === "buy") {
      const notional = order.notional ?? round(mul(order.qty!, fillPrice), 2, "up");
      qty = order.qty ?? round(div(notional, fillPrice, 12, "down"), 9, "down");
      const cost = order.qty ? round(mul(qty, fillPrice), 2, "up") : notional;
      if (compare(cost, this.cash) > 0) {
        order.status = "rejected";
        order.updatedAt = at;
        return;
      }
      this.cash = sub(this.cash, cost);
      this.holdings.set(order.symbol, { qty: add(held.qty, qty), costBasis: add(held.costBasis, cost) });
    } else {
      qty = order.qty ?? round(div(order.notional!, fillPrice, 12, "down"), 9, "down");
      if (compare(qty, held.qty) > 0) {
        order.status = "rejected";
        order.updatedAt = at;
        return;
      }
      this.cash = add(this.cash, round(mul(qty, fillPrice), 2, "down"));
      const left = sub(held.qty, qty);
      if (compare(left, "0") <= 0) this.holdings.delete(order.symbol);
      else this.holdings.set(order.symbol, { qty: left, costBasis: round(mul(held.costBasis, div(left, held.qty, 12, "half-even")), 6, "half-even") });
    }
    order.status = "filled";
    order.filledQty = qty;
    order.filledAvgPrice = fillPrice;
    order.updatedAt = at;
    this.activities.push({ id: this.nextId("fill"), type: "FILL", at, symbol: order.symbol, side: order.side, qty, price: fillPrice, netAmount: null, orderId: order.id, raw: {} });
  }

  // --- BrokerAdapter --------------------------------------------------------------

  async getAccount(): Promise<Account> {
    this.settle();
    let value = "0";
    let previous = this.cash;
    for (const [symbol, h] of this.holdings) {
      value = add(value, mul(h.qty, this.priceNow(symbol) ?? "0"));
      previous = add(previous, mul(h.qty, this.lastClose(symbol) ?? "0"));
    }
    const equity = round(add(this.cash, value), 2, "half-even");
    return {
      accountNumber: "SIM00000001",
      status: "ACTIVE",
      currency: "USD",
      cash: this.cash,
      equity,
      lastEquity: round(previous, 2, "half-even"),
      longMarketValue: round(value, 2, "half-even"),
      buyingPower: this.cash,
      multiplier: "1",
      tradingBlocked: false,
      accountBlocked: false,
      tradeSuspendedByUser: false,
    };
  }

  async getAccountConfig(): Promise<AccountConfig> {
    return { ...SIM_CONFIG };
  }

  updateAccountConfig(): never {
    throw new Error("updateAccountConfig isn't simulated");
  }

  async getClock(): Promise<Clock> {
    this.settle();
    const today = this.session(marketDate(this.now));
    const isOpen = !!today && this.now >= today.open && this.now < today.close;
    const next = this.market.calendar.find((d) => d.open > this.now);
    const nextClose = isOpen ? today!.close : (next?.close ?? this.now);
    return { timestamp: this.now, isOpen, nextOpen: next?.open ?? this.now, nextClose };
  }

  async getCalendar(start: string, end: string): Promise<CalendarDay[]> {
    return this.market.calendar.filter((d) => d.date >= start && d.date <= end);
  }

  async getPositions(): Promise<Position[]> {
    this.settle();
    return [...this.holdings].map(([symbol, h]) => {
      const price = this.priceNow(symbol) ?? "0";
      return {
        symbol,
        qty: h.qty,
        avgEntryPrice: div(h.costBasis, h.qty, 6, "half-even"),
        marketValue: round(mul(h.qty, price), 6, "half-even"),
        costBasis: h.costBasis,
        currentPrice: price,
      };
    });
  }

  async getOrders(after: Date): Promise<BrokerOrder[]> {
    this.settle();
    return this.orders.filter((o) => o.createdAt > after).map((o) => ({ ...o }));
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    this.settle();
    const o = this.orders.find((x) => x.clientOrderId === clientOrderId);
    return o ? { ...o } : null;
  }

  async submitOrder(request: OrderRequest): Promise<BrokerOrder> {
    this.settle();
    if (this.orders.some((o) => o.clientOrderId === request.clientOrderId)) {
      throw new BrokerHttpError(422, 40010001, "POST /v2/orders: client_order_id must be unique");
    }
    if (!this.market.assets[request.symbol]) throw new BrokerHttpError(422, 40010001, `POST /v2/orders: asset ${request.symbol} not found`);
    const order: BrokerOrder = {
      id: this.nextId("order"),
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      notional: request.notional ?? null,
      qty: request.qty ?? null,
      filledQty: "0",
      filledAvgPrice: null,
      status: "accepted",
      createdAt: this.now,
      updatedAt: this.now,
      submittedAt: this.now,
      raw: {},
    };
    this.orders.push(order);
    this.settle();
    return { ...order };
  }

  async getActivities(after?: Date): Promise<Activity[]> {
    this.settle();
    return this.activities.filter((a) => !after || a.at > after).map((a) => ({ ...a }));
  }

  async getAsset(symbol: string): Promise<Asset | null> {
    return this.market.assets[symbol] ?? null;
  }

  async getDailyBars(symbols: string[], start: Date, end: Date): Promise<Record<string, Bar[]>> {
    const today = marketDate(this.now);
    const session = this.session(today);
    const from = marketDate(start);
    const to = marketDate(end < this.now ? end : this.now);
    return Object.fromEntries(
      symbols.map((s) => {
        const bars = (this.market.bars[s] ?? []).filter((b) => {
          const d = marketDate(b.t);
          if (d < from || d > to) return false;
          // Today's bar exists only once the session has opened.
          return d < today || (!!session && this.now >= session.open);
        });
        return [
          s,
          bars.map((b) => {
            // Before the close, today's bar is partial: all we'd know is the open.
            if (marketDate(b.t) === today && session && this.now < session.close) return { ...b, h: b.o, l: b.o, c: b.o, v: "0" };
            return { ...b };
          }),
        ];
      }),
    );
  }
}
