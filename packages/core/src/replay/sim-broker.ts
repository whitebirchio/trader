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
  /** Each symbol's bar dates, in the bars' order (oldest first): getDailyBars slices by them instead of formatting every bar's date per call. */
  private readonly barDates: Record<string, string[]>;
  /** Cash and holdings as each session closed, by date: what lastEquity reports, as Alpaca's last_equity does. */
  private readonly atClose = new Map<string, { cash: string; holdings: Map<string, Holding> }>();
  private readonly startingCash: string;
  private seq = 0;

  constructor(
    private readonly market: SimMarket,
    options: SimOptions,
  ) {
    this.now = options.now;
    this.cash = options.cash;
    this.startingCash = options.cash;
    this.slippage = div(String(options.slippageBps ?? 10), "10000", 6, "half-even");
    this.barsByDate = Object.fromEntries(Object.entries(market.bars).map(([s, bars]) => [s, new Map(bars.map((b) => [marketDate(b.t), b]))]));
    this.barDates = Object.fromEntries(Object.entries(market.bars).map(([s, bars]) => [s, bars.map((b) => marketDate(b.t))]));
  }

  // --- The simulation's own controls (not part of BrokerAdapter) ----------------

  /** Move the clock. Closes passed on the way are recorded, then orders waiting for a session that has now opened are filled. */
  setNow(now: Date): void {
    // Nothing changes between events, so the state when a close passes is the state at that close.
    for (const d of this.market.calendar) {
      if (d.close > this.now && d.close <= now) this.atClose.set(d.date, { cash: this.cash, holdings: new Map([...this.holdings].map(([s, h]) => [s, { ...h }])) });
    }
    this.now = now;
    this.settle();
  }

  /**
   * Money moves now, as Alpaca records a transfer (an activity the ledger
   * books): positive in (CSD), negative out (CSW). A withdrawal larger than
   * the cash takes what's there and returns the shortfall: history sold to
   * fund it, but the replay's holdings can differ.
   */
  transfer(amount: string): { shortfall: string } {
    this.settle();
    let moved = amount;
    let shortfall = "0";
    if (compare(amount, "0") < 0 && compare(sub("0", amount), this.cash) > 0) {
      moved = sub("0", this.cash);
      shortfall = sub(sub("0", amount), this.cash);
    }
    if (compare(moved, "0") === 0) return { shortfall };
    this.cash = add(this.cash, moved);
    const type = compare(moved, "0") > 0 ? "CSD" : "CSW";
    this.activities.push({ id: this.nextId(type.toLowerCase()), type, at: this.now, symbol: null, side: null, qty: null, price: null, netAmount: moved, orderId: null, raw: { status: "executed", created_at: this.now.toISOString() } });
    return { shortfall };
  }

  /** A deposit: transfer(amount) with a positive amount. */
  deposit(amount: string): void {
    this.transfer(amount);
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

  /** Equity at the last session close before today, valued at that day's closes; the starting cash before any close. */
  private lastEquity(): string {
    const today = marketDate(this.now);
    const date = [...this.atClose.keys()].filter((d) => d < today).sort().at(-1);
    if (!date) return this.startingCash;
    const state = this.atClose.get(date)!;
    let equity = state.cash;
    for (const [symbol, h] of state.holdings) equity = add(equity, mul(h.qty, this.barsByDate[symbol]?.get(date)?.c ?? "0"));
    return round(equity, 2, "half-even");
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
    for (const [symbol, h] of this.holdings) value = add(value, mul(h.qty, this.priceNow(symbol) ?? "0"));
    const equity = round(add(this.cash, value), 2, "half-even");
    return {
      accountNumber: "SIM00000001",
      status: "ACTIVE",
      currency: "USD",
      cash: this.cash,
      equity,
      lastEquity: this.lastEquity(),
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
    // The first index whose date is at least `date` (dates ascending).
    const firstFrom = (dates: string[], date: string) => {
      let lo = 0;
      let hi = dates.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid]! < date) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return Object.fromEntries(
      symbols.map((s) => {
        const all = this.market.bars[s] ?? [];
        const dates = this.barDates[s] ?? [];
        const out: Bar[] = [];
        for (let i = firstFrom(dates, from); i < dates.length && dates[i]! <= to; i++) {
          const d = dates[i]!;
          const b = all[i]!;
          // Today's bar exists only once the session has opened.
          if (d === today && !(session && this.now >= session.open)) continue;
          // Before the close, today's bar is partial: all we'd know is the open.
          out.push(d === today && session && this.now < session.close ? { ...b, h: b.o, l: b.o, c: b.o, v: "0" } : { ...b });
        }
        return [s, out];
      }),
    );
  }
}
