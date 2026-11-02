import { beforeEach, describe, expect, it } from "vitest";
import { processCapital, queueCommand } from "../../src/capital/commands.js";
import { fallbackStrategy } from "../../src/capital/funding.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, brokerAccount, positions, withdrawals } from "../../src/db/schema.js";
import { activeStrategy, submitStrategy } from "../../src/portfolio/store.js";
import { validateStrategy } from "../../src/portfolio/strategy.js";
import { LIMITS } from "../../src/risk/limits.js";
import { marketTimeToUtc } from "../../src/time.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const two = strategy({
  conviction: [thesis({ id: "aapl-a", symbol: "AAPL", targetWeightPct: "20" }), thesis({ id: "msft-a", symbol: "MSFT", targetWeightPct: "10" })],
});
const build = (o: Partial<Parameters<typeof fallbackStrategy>[0]> = {}) =>
  fallbackStrategy({ active: two, values: { AAPL: "200", MSFT: "100", VTI: "700" }, equity: "1000", outstanding: "500", stoppedIds: new Set(), why: "Claude didn't plan it in time", limits: LIMITS, ...o });
const weights = (s: ReturnType<typeof build>) => Object.fromEntries(s.conviction.map((t) => [t.symbol, t.targetWeightPct]));

describe("fallbackStrategy (SPEC-capital decision 1)", () => {
  it("keeps each thesis's dollars: its weight grows as the account shrinks", () => {
    const s = build();
    // $200 of AAPL in what stays invested ($500) is 40%: over the 20% thesis limit, so held at 20%.
    expect(weights(s)).toEqual({ AAPL: "20", MSFT: "20" });
    const small = build({ outstanding: "100" });
    // $900 stays: AAPL $200 → 22.2% (capped at 20), MSFT $100 → 11.1111%.
    expect(weights(small)).toEqual({ AAPL: "20", MSFT: "11.1111" });
    expect(validateStrategy(small).ok).toBe(true);
  });

  it("changes nothing but the weights and the summary", () => {
    const s = build({ outstanding: "100" });
    expect(s.systematic).toEqual(two.systematic);
    expect(s.drift).toEqual(two.drift);
    expect(s.conviction.map((t) => [t.id, t.stopLossPct, t.evidence])).toEqual(two.conviction.map((t) => [t.id, t.stopLossPct, t.evidence]));
    expect(s.summary).toContain("Fallback funding for a $100 withdrawal: Claude didn't plan it in time.");
    expect(s.summary).toContain("MSFT keeps $100 (11.1111% of what stays invested)");
    expect(s.summary).toContain("AAPL goes from $200 to $180 (the 20% thesis limit)");
  });

  it("keeps a thesis not bought yet at its planned dollars", () => {
    expect(weights(build({ values: { AAPL: "200", VTI: "800" }, outstanding: "100" }))).toEqual({ AAPL: "20", MSFT: "11.1111" });
  });

  it("trims theses pro rata when they're worth more than what stays invested", () => {
    const s = build({ values: { AAPL: "200", MSFT: "100" }, equity: "300", outstanding: "150", active: strategy({ conviction: two.conviction.map((t) => ({ ...t, targetWeightPct: "20" })) }) });
    // $300 of theses, $150 stays: each halves. AAPL 66.7% → 20% cap; MSFT 33.3% → 20% cap.
    expect(weights(s)).toEqual({ AAPL: "20", MSFT: "20" });
    expect(s.summary).toContain("trimmed pro rata");
  });

  it("drops stopped theses (they can't be resubmitted)", () => {
    expect(build({ stoppedIds: new Set(["msft-a"]) }).conviction.map((t) => t.id)).toEqual(["aapl-a"]);
  });

  it("leaves the weights alone when nothing stays invested", () => {
    expect(weights(build({ outstanding: "1000" }))).toEqual({ AAPL: "20", MSFT: "10" });
  });
});

describe("the fallback funds an open request (process-capital)", () => {
  let db: Db;
  const at = (time: string) => marketTimeToUtc("2026-11-02", time);
  const broker = new FakeBroker();
  broker.calendar = ["2026-11-02", "2026-11-03"].map((date) => ({ date, open: marketTimeToUtc(date, "09:30"), close: marketTimeToUtc(date, "16:00") }));

  beforeEach(async () => {
    ({ db } = await createTestDb());
    await db.insert(brokerAccount).values({ id: 1, accountNumber: "PA1", status: "ACTIVE", cash: "0", equity: "1000", longMarketValue: "1000", buyingPower: "0", multiplier: "1", tradingBlocked: false, accountBlocked: false, config: {}, tradingAllowed: true, syncedAt: at("10:00") });
    await db.insert(positions).values([
      { symbol: "AAPL", qty: "1", avgEntryPrice: "200", marketValue: "200", costBasis: "200", currentPrice: "200", syncedAt: at("10:00") },
      { symbol: "VTI", qty: "2.666666666", avgEntryPrice: "300", marketValue: "800", costBasis: "800", currentPrice: "300", syncedAt: at("10:00") },
    ]);
    await submitStrategy(db, strategy({ conviction: [thesis({ id: "aapl-a", symbol: "AAPL", targetWeightPct: "20" })] }), "claude", new Date("2026-10-20T14:00:00Z"));
  });

  it("after Claude's window closes, submits a system version and moves to funding", async () => {
    await queueCommand(db, { kind: "request", amount: "200", requestedBy: "cli" }, at("10:00"));
    await processCapital(db, broker, at("10:00"));
    expect((await db.select().from(withdrawals))[0]?.status).toBe("planning");

    const result = await processCapital(db, broker, at("13:00"));
    expect(result).toMatchObject({ withdrawal: { state: "funding", steps: ["funding"] }, fallbackVersion: 2 });
    const active = await activeStrategy(db, at("13:00"));
    expect(active).toMatchObject({ version: 2, authoredBy: "system", reaffirmedAt: new Date("2026-10-20T14:00:00Z") });
    expect(active.strategy.conviction[0]?.targetWeightPct).toBe("20"); // $200 of $800: 25%, capped at 20
    expect((await db.select().from(withdrawals))[0]).toMatchObject({ fundingVersion: 2, fundedBy: "system" });
    const kinds = (await db.select().from(auditEvents)).map((e) => [e.kind, e.actor]);
    expect(kinds).toContainEqual(["strategy.activated", "system"]);
    expect(kinds).toContainEqual(["capital.funding_planned", "system"]);
  });

  it("fund_now runs the fallback on the same tick", async () => {
    await queueCommand(db, { kind: "request", amount: "200", requestedBy: "cli" }, at("10:00"));
    await queueCommand(db, { kind: "fund_now", requestedBy: "cli" }, at("10:01"));
    expect(await processCapital(db, broker, at("10:02"))).toMatchObject({ withdrawal: { state: "funding" }, fallbackVersion: 2 });
  });
});
