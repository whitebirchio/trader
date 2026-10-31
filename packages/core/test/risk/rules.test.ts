import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/risk/limits.js";
import { evaluateOrders } from "../../src/risk/rules.js";
import type { AssetFacts, Proposal, RiskSnapshot } from "../../src/risk/types.js";

const NOW = new Date("2026-11-02T15:00:00Z");

const facts = (symbol: string, overrides: Partial<AssetFacts> = {}): AssetFacts => ({
  symbol,
  name: `${symbol} Inc. Common Stock`,
  tradable: true,
  fractionable: true,
  marginRequirementLong: "30",
  lastClose: "100",
  avgDollarVolume: "500000000",
  historyDays: 3000,
  ...overrides,
});

/** $1,000 account, all cash, healthy, freshly synced. */
function snapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    now: NOW,
    equity: "1000",
    cash: "1000",
    holdings: [],
    index: { drawdownPct: "0", dailyChangePct: "0" },
    broker: { tradingAllowed: true, blockedReasons: [], syncedAt: new Date(NOW.getTime() - 5 * 60_000) },
    state: { killSwitch: false, killReason: null, halted: false, haltReason: null },
    today: { orderCount: 0, buyNotional: "0" },
    assets: {
      VTI: facts("VTI", { name: "Vanguard Total Stock Market ETF" }),
      AAPL: facts("AAPL"),
      MSFT: facts("MSFT"),
      NVDA: facts("NVDA"),
      TQQQ: facts("TQQQ", { name: "ProShares UltraPro QQQ", marginRequirementLong: "75" }),
    },
    ...overrides,
  };
}

const buy = (symbol: string, notional: string, sleeve: "core" | "satellite" = "core"): Proposal => ({
  key: `k:${symbol}:buy:${notional}`,
  symbol,
  side: "buy",
  sleeve,
  notional,
});
const sell = (symbol: string, qty: string): Proposal => ({ key: `k:${symbol}:sell`, symbol, side: "sell", sleeve: "core", qty });
const run = (s: RiskSnapshot, ...p: Proposal[]) => evaluateOrders(s, p, LIMITS);

describe("account-wide stops block everything, sells included", () => {
  const holding = { symbol: "VTI", qty: "1", marketValue: "300", sleeve: "core" as const };

  it.each([
    [{ state: { killSwitch: true, killReason: "testing", halted: false, haltReason: null } }, "The kill switch is on (testing). Only the owner can turn it off (risk:resume)."],
    [{ state: { killSwitch: false, killReason: null, halted: true, haltReason: "down 21% from peak" } }, "Trading is halted: down 21% from peak. Only the owner can resume it (risk:resume)."],
    [{ broker: { tradingAllowed: false, blockedReasons: ["margin multiplier 4 (must be 1)"], syncedAt: NOW } }, "The broker safety check failed: margin multiplier 4 (must be 1)."],
    [{ broker: { tradingAllowed: true, blockedReasons: [], syncedAt: new Date(NOW.getTime() - 21 * 60_000) } }, "Broker data is 21 minutes old (limit 20)."],
    [{ broker: { tradingAllowed: true, blockedReasons: [], syncedAt: null } }, "Broker data has never been synced."],
  ])("%o", (overrides, reason) => {
    const decisions = run(snapshot({ holdings: [holding], ...overrides }), buy("VTI", "50"), sell("VTI", "1"));
    expect(decisions.map((d) => [d.verdict, d.reasons])).toEqual([
      ["rejected", [reason]],
      ["rejected", [reason]],
    ]);
  });

  it("puts the kill switch ahead of everything else", () => {
    const [d] = run(
      snapshot({
        state: { killSwitch: true, killReason: null, halted: true, haltReason: "x" },
        broker: { tradingAllowed: false, blockedReasons: ["y"], syncedAt: null },
      }),
      buy("VTI", "50"),
    );
    expect(d?.reasons[0]).toMatch(/^The kill switch is on\./);
  });
});

describe("daily loss pause", () => {
  const down = snapshot({
    index: { drawdownPct: "5", dailyChangePct: "-5.2" },
    holdings: [{ symbol: "VTI", qty: "1", marketValue: "300", sleeve: "core" }],
  });

  it("rejects buys", () => {
    expect(run(down, buy("VTI", "50"))[0]).toMatchObject({
      verdict: "rejected",
      reasons: ["Buys are paused for today: the account is down 5.2% since yesterday's close (limit 5%)."],
    });
  });

  it("still lets sells run", () => {
    expect(run(down, sell("VTI", "1"))[0]).toMatchObject({ verdict: "approved", qty: "1" });
  });

  it("doesn't trigger just under the limit", () => {
    expect(run(snapshot({ index: { drawdownPct: "0", dailyChangePct: "-4.99" } }), buy("VTI", "50"))[0]?.verdict).toBe("approved");
  });
});

describe("sells", () => {
  const held = snapshot({ holdings: [{ symbol: "AAPL", qty: "0.5", marketValue: "115", sleeve: "satellite" }] });

  it("are approved up to the shares held", () => {
    expect(run(held, sell("AAPL", "0.25"))[0]).toMatchObject({ verdict: "approved", qty: "0.25", reasons: [] });
  });

  it("are clipped to the shares held (no shorting)", () => {
    expect(run(held, sell("AAPL", "2"))[0]).toMatchObject({
      verdict: "clipped",
      qty: "0.5",
      reasons: ["Sell reduced to the 0.5 AAPL shares held (no shorting)."],
    });
  });

  it("are rejected when nothing is held, and consume what earlier sells used", () => {
    const [first, second] = run(held, sell("AAPL", "0.5"), sell("AAPL", "0.1"));
    expect(first?.verdict).toBe("approved");
    expect(second).toMatchObject({ verdict: "rejected", reasons: ["No AAPL shares are held to sell."] });
  });

  it("ignore eligibility: an ineligible holding can always be sold", () => {
    const s = snapshot({ holdings: [{ symbol: "TQQQ", qty: "1", marketValue: "80", sleeve: "satellite" }] });
    expect(run(s, sell("TQQQ", "1"))[0]?.verdict).toBe("approved");
  });
});

describe("buy eligibility", () => {
  it("rejects leveraged funds with a readable reason", () => {
    expect(run(snapshot(), buy("TQQQ", "20", "satellite"))[0]).toMatchObject({
      verdict: "rejected",
      reasons: ["TQQQ is leveraged or inverse (margin requirement 75%)."],
    });
  });

  it("rejects a symbol with no facts", () => {
    expect(run(snapshot(), buy("ZZZZ", "20"))[0]?.reasons).toEqual(["Couldn't verify ZZZZ's eligibility (no asset data)."]);
  });
});

describe("position cap (20%, broad ETFs exempt)", () => {
  it("leaves broad ETFs uncapped", () => {
    expect(run(snapshot(), buy("VTI", "900"))[0]).toMatchObject({ verdict: "approved", notional: "900" });
  });

  it("clips a single stock to 20% of equity", () => {
    expect(run(snapshot(), buy("AAPL", "300", "satellite"))[0]).toMatchObject({
      verdict: "clipped",
      notional: "200",
      reasons: ["Reduced to keep AAPL within 20% of equity ($200)."],
    });
  });

  it("counts the existing position", () => {
    const s = snapshot({ holdings: [{ symbol: "AAPL", qty: "0.6", marketValue: "150", sleeve: "satellite" }] });
    expect(run(s, buy("AAPL", "100", "satellite"))[0]).toMatchObject({ verdict: "clipped", notional: "50" });
  });

  it("rejects once the position is at its cap", () => {
    const s = snapshot({ holdings: [{ symbol: "AAPL", qty: "1", marketValue: "199.5", sleeve: "satellite" }] });
    expect(run(s, buy("AAPL", "10", "satellite"))[0]).toMatchObject({
      verdict: "rejected",
      reasons: ["AAPL is already at its 20% position limit ($200)."],
    });
  });
});

describe("satellite sleeve cap (30%)", () => {
  it("clips the buy that would cross it, across proposals", () => {
    const decisions = run(snapshot(), buy("AAPL", "200", "satellite"), buy("MSFT", "200", "satellite"));
    expect(decisions.map((d) => [d.verdict, d.notional])).toEqual([
      ["approved", "200"],
      ["clipped", "100"],
    ]);
    expect(decisions[1]?.reasons).toEqual(["Reduced to keep the satellite sleeve within 30% of equity ($300)."]);
  });

  it("doesn't apply to core buys", () => {
    const s = snapshot({ holdings: [{ symbol: "AAPL", qty: "1", marketValue: "300", sleeve: "satellite" }], cash: "700" });
    expect(run(s, buy("MSFT", "100", "core"))[0]?.verdict).toBe("approved");
  });
});

describe("cash", () => {
  it("keeps a buffer (max of $5 or 1% of equity) and clips the last buy", () => {
    const decisions = run(snapshot(), buy("VTI", "900"), buy("VTI", "200"));
    expect(decisions.map((d) => [d.verdict, d.notional])).toEqual([
      ["approved", "900"],
      ["clipped", "90"],
    ]);
    expect(decisions[1]?.reasons).toEqual(["Reduced to the cash available ($90, keeping a $10 buffer)."]);
  });

  it("rejects when less than $1 would remain", () => {
    const s = snapshot({ cash: "10.50" });
    expect(run(s, buy("VTI", "50"))[0]).toMatchObject({
      verdict: "rejected",
      reasons: ["Not enough cash: $0.5 available after the $10 buffer."],
    });
  });

  it("composes with other clips", () => {
    const s = snapshot({ cash: "150" });
    expect(run(s, buy("AAPL", "300", "satellite"))[0]).toMatchObject({
      verdict: "clipped",
      notional: "140",
      reasons: ["Reduced to keep AAPL within 20% of equity ($200).", "Reduced to the cash available ($140, keeping a $10 buffer)."],
    });
  });
});

describe("runaway guard", () => {
  it("rejects orders past the daily count", () => {
    const s = snapshot({ today: { orderCount: 39, buyNotional: "0" } });
    expect(run(s, buy("VTI", "10"), buy("VTI", "10")).map((d) => d.verdict)).toEqual(["approved", "rejected"]);
  });

  it("caps a day's buys at 100% of equity", () => {
    const s = snapshot({ today: { orderCount: 2, buyNotional: "950" }, cash: "1000" });
    expect(run(s, buy("VTI", "100"))[0]).toMatchObject({
      verdict: "clipped",
      notional: "50",
      reasons: ["Reduced to stay within today's buy limit (100% of equity, $1000)."],
    });
  });
});

describe("input hygiene", () => {
  it("rejects malformed sizes", () => {
    expect(run(snapshot(), buy("VTI", "-5"))[0]?.reasons).toEqual(['Invalid buy amount "-5".']);
    expect(run(snapshot(), sell("VTI", "abc"))[0]?.reasons).toEqual(['Invalid sell quantity "abc".']);
  });

  it("rounds buy amounts down to cents", () => {
    expect(run(snapshot(), buy("VTI", "10.019"))[0]).toMatchObject({ verdict: "approved", notional: "10.01" });
  });

  it("is deterministic", () => {
    const s = snapshot();
    const p = [buy("AAPL", "300", "satellite"), buy("VTI", "500")];
    expect(run(s, ...p)).toEqual(run(s, ...p));
  });
});
