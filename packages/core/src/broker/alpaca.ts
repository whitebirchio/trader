import { z } from "zod";
import type { TradingEnv } from "../env.js";
import { decimalString } from "../money.js";
import { marketTimeToUtc } from "../time.js";
import { alpacaHosts } from "./hosts.js";
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
} from "./port.js";

export interface AlpacaBrokerOptions {
  env: TradingEnv;
  keyId: string;
  secretKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

// Free market-data plan: SIP data newer than 15 minutes is refused (HTTP 403).
const SIP_DELAY_MS = 16 * 60_000;
const ACTIVITY_PAGE = 100;
const ORDER_PAGE = 500;

// ---------------------------------------------------------------------------
// Response schemas. Zod-parse at the edge so an unexpected shape fails one
// sync loudly instead of writing a bad row. Money stays a decimal string.
// ---------------------------------------------------------------------------

const dec = decimalString;
const isoDate = z.string().transform((s, ctx) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: "invalid date" });
    return z.NEVER;
  }
  return d;
});
const side = z.enum(["buy", "sell"]);

const accountSchema = z.object({
  account_number: z.string(),
  status: z.string(),
  currency: z.string(),
  cash: dec,
  equity: dec,
  last_equity: dec,
  long_market_value: dec,
  buying_power: dec,
  multiplier: z.string(),
  trading_blocked: z.boolean(),
  account_blocked: z.boolean(),
  trade_suspended_by_user: z.boolean().default(false),
});

const configSchema = z.object({
  max_margin_multiplier: z.string(),
  no_shorting: z.boolean(),
  fractional_trading: z.boolean(),
  suspend_trade: z.boolean(),
});

const clockSchema = z.object({
  timestamp: isoDate,
  is_open: z.boolean(),
  next_open: isoDate,
  next_close: isoDate,
});

const calendarSchema = z.array(
  z.object({ date: z.string(), open: z.string(), close: z.string() }),
);

const positionSchema = z.object({
  symbol: z.string(),
  qty: dec,
  avg_entry_price: dec,
  market_value: dec,
  cost_basis: dec,
  current_price: dec,
});

const orderSchema = z.object({
  id: z.string(),
  client_order_id: z.string(),
  symbol: z.string(),
  side,
  notional: dec.nullable(),
  qty: dec.nullable(),
  filled_qty: dec,
  filled_avg_price: dec.nullable(),
  status: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  submitted_at: isoDate.nullable(),
});

const fillSchema = z.object({
  id: z.string(),
  activity_type: z.literal("FILL"),
  transaction_time: isoDate,
  symbol: z.string(),
  side,
  qty: dec,
  price: dec,
  order_id: z.string(),
});

const nonTradeSchema = z.object({
  id: z.string(),
  activity_type: z.string(),
  date: z.string(),
  created_at: isoDate.optional(),
  symbol: z.string().optional(),
  qty: dec.optional(),
  per_share_amount: dec.optional(),
  net_amount: dec.optional(),
});

const assetSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  status: z.string(),
  tradable: z.boolean(),
  fractionable: z.boolean(),
});

// Bars arrive as JSON numbers. String() of a parsed double is its shortest
// round-trip decimal, i.e. the text Alpaca sent, so this is lossless for prices.
const num = z.number().refine(Number.isFinite).transform(String);
const barsSchema = z.object({
  bars: z
    .record(
      z.string(),
      z.array(z.object({ t: isoDate, o: num, h: num, l: num, c: num, v: num })).nullable(),
    )
    .nullable(),
  next_page_token: z.string().nullable(),
});

type Json = Record<string, unknown>;

function toOrder(raw: Json): BrokerOrder {
  const o = orderSchema.parse(raw);
  return {
    id: o.id,
    clientOrderId: o.client_order_id,
    symbol: o.symbol,
    side: o.side,
    notional: o.notional,
    qty: o.qty,
    filledQty: o.filled_qty,
    filledAvgPrice: o.filled_avg_price,
    status: o.status,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    submittedAt: o.submitted_at,
    raw,
  };
}

function toActivity(raw: Json): Activity {
  if (raw.activity_type === "FILL") {
    const a = fillSchema.parse(raw);
    return {
      id: a.id,
      type: "FILL",
      at: a.transaction_time,
      symbol: a.symbol,
      side: a.side,
      qty: a.qty,
      price: a.price,
      netAmount: null,
      orderId: a.order_id,
      raw,
    };
  }
  const a = nonTradeSchema.parse(raw);
  return {
    id: a.id,
    type: a.activity_type,
    // Non-trade activities carry a booking date; created_at is the precise instant when present.
    at: a.created_at ?? new Date(`${a.date}T00:00:00Z`),
    symbol: a.symbol ?? null,
    side: null,
    qty: a.qty ?? null,
    price: a.per_share_amount ?? null,
    netAmount: a.net_amount ?? null,
    orderId: null,
    raw,
  };
}

export class AlpacaBroker implements BrokerAdapter {
  private readonly hosts;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(opts: AlpacaBrokerOptions) {
    this.hosts = alpacaHosts(opts.env);
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.headers = { "APCA-API-KEY-ID": opts.keyId, "APCA-API-SECRET-KEY": opts.secretKey };
  }

  /** Returns parsed JSON, or null on 404 when `allow404` is set. Errors never include headers. */
  private async request(
    host: "trading" | "data",
    path: string,
    init: { method?: string; body?: unknown; allow404?: boolean } = {},
  ): Promise<unknown> {
    const res = await this.fetch(`${this.hosts[host]}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...this.headers,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404 && init.allow404) return null;
    if (!res.ok) {
      let code: number | null = null;
      let message = res.statusText || `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { code?: unknown; message?: unknown };
        if (typeof body.code === "number") code = body.code;
        if (typeof body.message === "string") message = body.message;
      } catch {
        // Non-JSON error body: keep the status text.
      }
      throw new BrokerHttpError(res.status, code, `${init.method ?? "GET"} ${path.split("?")[0]}: ${message}`);
    }
    return res.json();
  }

  async getAccount(): Promise<Account> {
    const a = accountSchema.parse(await this.request("trading", "/v2/account"));
    return {
      accountNumber: a.account_number,
      status: a.status,
      currency: a.currency,
      cash: a.cash,
      equity: a.equity,
      lastEquity: a.last_equity,
      longMarketValue: a.long_market_value,
      buyingPower: a.buying_power,
      multiplier: a.multiplier,
      tradingBlocked: a.trading_blocked,
      accountBlocked: a.account_blocked,
      tradeSuspendedByUser: a.trade_suspended_by_user,
    };
  }

  private static toConfig(c: z.infer<typeof configSchema>): AccountConfig {
    return {
      maxMarginMultiplier: c.max_margin_multiplier,
      noShorting: c.no_shorting,
      fractionalTrading: c.fractional_trading,
      suspendTrade: c.suspend_trade,
    };
  }

  async getAccountConfig(): Promise<AccountConfig> {
    return AlpacaBroker.toConfig(
      configSchema.parse(await this.request("trading", "/v2/account/configurations")),
    );
  }

  async updateAccountConfig(patch: Partial<AccountConfig>): Promise<AccountConfig> {
    const body: Record<string, unknown> = {};
    if (patch.maxMarginMultiplier !== undefined) body.max_margin_multiplier = patch.maxMarginMultiplier;
    if (patch.noShorting !== undefined) body.no_shorting = patch.noShorting;
    if (patch.fractionalTrading !== undefined) body.fractional_trading = patch.fractionalTrading;
    if (patch.suspendTrade !== undefined) body.suspend_trade = patch.suspendTrade;
    const raw = await this.request("trading", "/v2/account/configurations", { method: "PATCH", body });
    return AlpacaBroker.toConfig(configSchema.parse(raw));
  }

  async getClock(): Promise<Clock> {
    const c = clockSchema.parse(await this.request("trading", "/v2/clock"));
    return { timestamp: c.timestamp, isOpen: c.is_open, nextOpen: c.next_open, nextClose: c.next_close };
  }

  async getCalendar(start: string, end: string): Promise<CalendarDay[]> {
    const days = calendarSchema.parse(
      await this.request("trading", `/v2/calendar?start=${start}&end=${end}`),
    );
    return days.map((d) => ({
      date: d.date,
      open: marketTimeToUtc(d.date, d.open),
      close: marketTimeToUtc(d.date, d.close),
    }));
  }

  async getPositions(): Promise<Position[]> {
    const rows = z.array(positionSchema).parse(await this.request("trading", "/v2/positions"));
    return rows.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avgEntryPrice: p.avg_entry_price,
      marketValue: p.market_value,
      costBasis: p.cost_basis,
      currentPrice: p.current_price,
    }));
  }

  async getOrders(after: Date): Promise<BrokerOrder[]> {
    const out = new Map<string, BrokerOrder>();
    let cursor = after;
    for (;;) {
      const qs = new URLSearchParams({
        status: "all",
        direction: "asc",
        nested: "false",
        limit: String(ORDER_PAGE),
        after: cursor.toISOString(),
      });
      const page = z.array(z.record(z.string(), z.unknown())).parse(
        await this.request("trading", `/v2/orders?${qs}`),
      );
      const orders = page.map(toOrder);
      for (const o of orders) out.set(o.id, o);
      const last = orders.at(-1);
      if (orders.length < ORDER_PAGE || !last) break;
      cursor = last.submittedAt ?? last.createdAt;
    }
    return [...out.values()];
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    const qs = new URLSearchParams({ client_order_id: clientOrderId });
    const raw = await this.request("trading", `/v2/orders:by_client_order_id?${qs}`, { allow404: true });
    return raw === null ? null : toOrder(raw as Json);
  }

  async submitOrder(request: OrderRequest): Promise<BrokerOrder> {
    const body: Record<string, unknown> = {
      symbol: request.symbol,
      side: request.side,
      type: "market",
      time_in_force: "day",
      client_order_id: request.clientOrderId,
    };
    if (request.notional !== undefined) body.notional = request.notional;
    else body.qty = request.qty;
    return toOrder((await this.request("trading", "/v2/orders", { method: "POST", body })) as Json);
  }

  async getActivities(after?: Date): Promise<Activity[]> {
    const out: Activity[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ direction: "asc", page_size: String(ACTIVITY_PAGE) });
      if (after) qs.set("after", after.toISOString());
      if (pageToken) qs.set("page_token", pageToken);
      const page = z.array(z.record(z.string(), z.unknown())).parse(
        await this.request("trading", `/v2/account/activities?${qs}`),
      );
      out.push(...page.map(toActivity));
      const last = page.at(-1);
      if (page.length < ACTIVITY_PAGE || !last) break;
      pageToken = String(last.id);
    }
    return out;
  }

  async getAsset(symbol: string): Promise<Asset | null> {
    const raw = await this.request("trading", `/v2/assets/${encodeURIComponent(symbol)}`, {
      allow404: true,
    });
    if (raw === null) return null;
    const a = assetSchema.parse(raw);
    return { symbol: a.symbol, name: a.name, status: a.status, tradable: a.tradable, fractionable: a.fractionable };
  }

  async getDailyBars(symbols: string[], start: Date, end: Date): Promise<Record<string, Bar[]>> {
    const latest = new Date(this.now().getTime() - SIP_DELAY_MS);
    const clampedEnd = end > latest ? latest : end;
    const out: Record<string, Bar[]> = Object.fromEntries(symbols.map((s) => [s, []]));
    let pageToken: string | null = null;
    do {
      const qs = new URLSearchParams({
        symbols: symbols.join(","),
        timeframe: "1Day",
        start: start.toISOString(),
        end: clampedEnd.toISOString(),
        adjustment: "all",
        feed: "sip",
        limit: "10000",
      });
      if (pageToken) qs.set("page_token", pageToken);
      const page = barsSchema.parse(await this.request("data", `/v2/stocks/bars?${qs}`));
      for (const [symbol, bars] of Object.entries(page.bars ?? {})) {
        (out[symbol] ??= []).push(...(bars ?? []));
      }
      pageToken = page.next_page_token;
    } while (pageToken);
    return out;
  }
}
