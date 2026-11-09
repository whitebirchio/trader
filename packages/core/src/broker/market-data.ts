import type { BrokerAdapter, CalendarDay } from "./port.js";

/**
 * A broker that only reads market and reference data: daily bars, asset
 * facts and the market calendar. The MCP server uses it (review finding R1),
 * so no tool, and no bug in one, can read the account or place an order
 * through it: everything else throws. In production it wraps a PAPER-account
 * client, so the public MCP function holds no live-account credential at all.
 */
export class MarketDataOnly implements BrokerAdapter {
  constructor(private readonly inner: Pick<BrokerAdapter, "getDailyBars" | "getAsset" | "getCalendar">) {}

  getDailyBars(symbols: string[], start: Date, end: Date) {
    return this.inner.getDailyBars(symbols, start, end);
  }
  getAsset(symbol: string) {
    return this.inner.getAsset(symbol);
  }
  getCalendar(start: string, end: string): Promise<CalendarDay[]> {
    return this.inner.getCalendar(start, end);
  }

  private refuse(method: string): never {
    throw new Error(`${method} isn't available here: this broker reads market data only (the account and orders are off limits)`);
  }
  getAccount(): never {
    return this.refuse("getAccount");
  }
  getAccountConfig(): never {
    return this.refuse("getAccountConfig");
  }
  updateAccountConfig(): never {
    return this.refuse("updateAccountConfig");
  }
  getClock(): never {
    return this.refuse("getClock");
  }
  getPositions(): never {
    return this.refuse("getPositions");
  }
  getOrders(): never {
    return this.refuse("getOrders");
  }
  getOrderByClientId(): never {
    return this.refuse("getOrderByClientId");
  }
  submitOrder(): never {
    return this.refuse("submitOrder");
  }
  getActivities(): never {
    return this.refuse("getActivities");
  }
}
