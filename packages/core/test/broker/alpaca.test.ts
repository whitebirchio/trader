import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AlpacaBroker } from "../../src/broker/alpaca.js";
import { BrokerHttpError } from "../../src/broker/port.js";
import { marketDate } from "../../src/time.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

const KEY = "PKTESTKEY0000000000000000A";
const SECRET = "secret0000000000000000000000000000000000000";
const NOW = new Date("2026-11-02T18:00:00Z");

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that routes by path to a handler and records every call. */
function fakeFetch(routes: Record<string, (url: URL, call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 599 });
    const { status = 200, body } = route(url, call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

function broker(routes: Parameters<typeof fakeFetch>[0], env: "staging" | "production" = "staging") {
  const f = fakeFetch(routes);
  return { b: new AlpacaBroker({ env, keyId: KEY, secretKey: SECRET, fetch: f.fn, now: () => NOW }), calls: f.calls };
}

describe("AlpacaBroker", () => {
  it("calls the env's host with the key headers", async () => {
    for (const [env, host] of [
      ["staging", "paper-api.alpaca.markets"],
      ["production", "api.alpaca.markets"],
    ] as const) {
      const { b, calls } = broker({ "/v2/account": () => ({ body: fixture("account") }) }, env);
      await b.getAccount();
      expect(calls[0]?.url.host).toBe(host);
      expect(calls[0]?.headers).toMatchObject({ "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET });
    }
  });

  it("parses the account and its configuration (recorded paper responses)", async () => {
    const { b } = broker({
      "/v2/account": () => ({ body: fixture("account") }),
      "/v2/account/configurations": () => ({ body: fixture("configurations") }),
    });
    expect(await b.getAccount()).toMatchObject({
      status: "ACTIVE",
      cash: "100000",
      multiplier: "4",
      tradingBlocked: false,
      accountBlocked: false,
    });
    expect(await b.getAccountConfig()).toEqual({
      maxMarginMultiplier: "4",
      noShorting: false,
      fractionalTrading: true,
      suspendTrade: false,
    });
  });

  it("patches the account configuration in Alpaca's field names", async () => {
    const { b, calls } = broker({
      "/v2/account/configurations": (_u, call) => ({
        body: { ...(fixture("configurations") as object), ...(call.body as object) },
      }),
    });
    const config = await b.updateAccountConfig({ maxMarginMultiplier: "1", noShorting: true });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ max_margin_multiplier: "1", no_shorting: true });
    expect(config).toMatchObject({ maxMarginMultiplier: "1", noShorting: true });
  });

  it("converts the clock and calendar session times to UTC instants", async () => {
    const { b } = broker({
      "/v2/clock": () => ({ body: fixture("clock") }),
      "/v2/calendar": () => ({ body: fixture("calendar") }),
    });
    const clock = await b.getClock();
    expect(clock.isOpen).toBe(false);
    expect(clock.nextOpen).toBeInstanceOf(Date);
    const days = await b.getCalendar("2026-10-30", "2026-11-03");
    const fri = days.find((d) => d.date === "2026-10-30");
    const mon = days.find((d) => d.date === "2026-11-02");
    expect(fri?.close.toISOString()).toBe("2026-10-30T20:00:00.000Z"); // EDT
    expect(mon?.close.toISOString()).toBe("2026-11-02T21:00:00.000Z"); // EST
  });

  it("parses positions, an order and a fill (synthetic, schema-shaped)", async () => {
    const { b } = broker({
      "/v2/positions": () => ({
        body: [
          {
            asset_id: "a",
            symbol: "VTI",
            qty: "0.016339869",
            avg_entry_price: "306.01",
            market_value: "5.01",
            cost_basis: "5",
            current_price: "306.6",
          },
        ],
      }),
      "/v2/orders:by_client_order_id": () => ({ body: fixture("synthetic-order") }),
      "/v2/account/activities": () => ({ body: [fixture("synthetic-fill")] }),
    });
    expect(await b.getPositions()).toEqual([
      {
        symbol: "VTI",
        qty: "0.016339869",
        avgEntryPrice: "306.01",
        marketValue: "5.01",
        costBasis: "5",
        currentPrice: "306.6",
      },
    ]);
    expect(await b.getOrderByClientId("stg-x")).toMatchObject({
      symbol: "VTI",
      notional: "5",
      qty: null,
      filledQty: "0.016339869",
      status: "filled",
    });
    const [fill] = await b.getActivities();
    expect(fill).toMatchObject({ type: "FILL", symbol: "VTI", side: "buy", qty: "0.016339869", price: "306.01", orderId: "order-1" });
    expect(fill?.at.toISOString()).toBe("2026-11-02T14:35:01.500Z");
  });

  it("dates non-trade activities by created_at (recorded paper journal)", async () => {
    const { b } = broker({ "/v2/account/activities": () => ({ body: fixture("activities") }) });
    const [journal] = await b.getActivities();
    expect(journal).toMatchObject({ type: "JNLC", netAmount: "100000", symbol: null, side: null });
    expect(journal?.at.toISOString()).toBe("2026-04-21T08:21:58.208Z");
  });

  it("keeps a date-only activity on its own market date (noon ET), in EDT and EST", async () => {
    // Midnight UTC would be the evening before in New York, filing a deposit
    // under the previous market date (SPEC-capital, the false-halt bug).
    const csd = (id: string, date: string) => ({ id, activity_type: "CSD", date, net_amount: "500", status: "executed" });
    const { b } = broker({ "/v2/account/activities": () => ({ body: [csd("d-edt", "2026-06-15"), csd("d-est", "2026-11-03")] }) });
    const [edt, est] = await b.getActivities();
    expect(edt && marketDate(edt.at)).toBe("2026-06-15");
    expect(edt?.at.toISOString()).toBe("2026-06-15T16:00:00.000Z");
    expect(est && marketDate(est.at)).toBe("2026-11-03");
    expect(est?.at.toISOString()).toBe("2026-11-03T17:00:00.000Z");
  });

  it("follows activity pages by the last id", async () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `act-${String(from + i).padStart(3, "0")}`,
        activity_type: "DIV",
        date: "2026-11-02",
        net_amount: "0.01",
        symbol: "VTI",
      }));
    const { b, calls } = broker({
      "/v2/account/activities": (url) => ({
        body: url.searchParams.get("page_token") ? page(100, 1) : page(0, 100),
      }),
    });
    const all = await b.getActivities(new Date("2026-11-01T00:00:00Z"));
    expect(all).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.searchParams.get("page_token")).toBe("act-099");
    expect(calls[0]?.url.searchParams.get("after")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("returns null for an unknown client order id or asset", async () => {
    const { b } = broker({
      "/v2/orders:by_client_order_id": () => ({ status: 404, body: { code: 40410000, message: "order not found" } }),
      "/v2/assets/NOPE": () => ({ status: 404, body: { code: 40410000, message: "asset not found" } }),
    });
    expect(await b.getOrderByClientId("stg-missing")).toBeNull();
    expect(await b.getAsset("NOPE")).toBeNull();
  });

  it("parses an asset (recorded)", async () => {
    const { b } = broker({ "/v2/assets/VTI": () => ({ body: fixture("asset-VTI") }) });
    expect(await b.getAsset("VTI")).toMatchObject({
      symbol: "VTI",
      tradable: true,
      fractionable: true,
      marginRequirementLong: "30",
    });
  });

  it("submits a notional market day order", async () => {
    const { b, calls } = broker({ "/v2/orders": () => ({ body: fixture("synthetic-order") }) });
    await b.submitOrder({ symbol: "VTI", side: "buy", notional: "5", clientOrderId: "stg-abc" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      symbol: "VTI",
      side: "buy",
      type: "market",
      time_in_force: "day",
      client_order_id: "stg-abc",
      notional: "5",
    });
  });

  it("raises a typed error without leaking credentials", async () => {
    const { b } = broker({
      "/v2/orders": () => ({ status: 403, body: { code: 40310000, message: "insufficient buying power" } }),
    });
    const err = await b
      .submitOrder({ symbol: "VTI", side: "buy", notional: "5", clientOrderId: "stg-abc" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerHttpError);
    expect(err).toMatchObject({ status: 403, code: 40310000 });
    expect(String((err as Error).message)).toContain("insufficient buying power");
    expect(String((err as Error).message)).not.toContain(SECRET);
  });

  it("clamps bar requests to the free plan's 15-minute delay, follows pages, and stringifies prices", async () => {
    const recorded = fixture("bars") as { bars: Record<string, unknown[]> };
    const { b, calls } = broker({
      "/v2/stocks/bars": (url) =>
        url.searchParams.get("page_token")
          ? { body: { bars: { VTI: [{ t: "2026-10-26T04:00:00Z", o: 300.1, h: 301, l: 299.5, c: 300.75, v: 1000 }] }, next_page_token: null } }
          : { body: { ...recorded, next_page_token: "tok" } },
    });
    const bars = await b.getDailyBars(["VTI", "SPY"], new Date("2026-10-26T00:00:00Z"), new Date("2026-11-02T20:00:00Z"));
    expect(calls[0]?.url.host).toBe("data.alpaca.markets");
    expect(calls[0]?.url.searchParams.get("feed")).toBe("sip");
    expect(calls[0]?.url.searchParams.get("adjustment")).toBe("all");
    expect(calls[0]?.url.searchParams.get("end")).toBe("2026-11-02T17:44:00.000Z"); // NOW − 16 min
    expect(calls[1]?.url.searchParams.get("page_token")).toBe("tok");
    expect(bars.SPY?.length).toBeGreaterThan(0);
    expect(typeof bars.SPY?.[0]?.c).toBe("string");
    expect(bars.VTI?.at(-1)).toMatchObject({ c: "300.75", o: "300.1" });
  });
});
