import { beforeEach, describe, expect, it } from "vitest";
import {
  checkEligibility,
  getActivity,
  getExposure,
  getHoldings,
  getOverview,
  getPrices,
  getRules,
  getStrategy,
  getTrackRecord,
  getWatchlist,
  previewStrategy,
  submitStrategyTool,
  type ToolDeps,
  updateWatchlistTool,
} from "../../src/agent/tools.js";
import { MarketDataOnly } from "../../src/broker/market-data.js";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";
import { FakeBroker } from "./fake-broker.js";

const NOW = new Date("2026-11-02T15:35:00Z");
const bars = (price: string, days = 300): Bar[] =>
  Array.from({ length: days }, (_, i) => ({ t: new Date(NOW.getTime() - (days - i) * 86_400_000), o: price, h: price, l: price, c: price, v: "1000000" }));

let fake: FakeBroker;
let deps: ToolDeps;

beforeEach(async () => {
  const { db } = await createTestDb();
  fake = new FakeBroker();
  fake.now = NOW;
  fake.assets.push({ symbol: "AAPL", name: "Apple Inc. Common Stock", status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" });
  fake.bars = { VTI: bars("300"), AAPL: bars("200") };
  await syncBroker(db, fake, "staging", NOW); // the engine's job, with the full broker
  deps = { db, broker: new MarketDataOnly(fake), env: "staging", now: NOW };
});

describe("MarketDataOnly", () => {
  it("passes market and reference data through, and refuses the account and orders", async () => {
    const broker = new MarketDataOnly(fake);
    expect((await broker.getDailyBars(["VTI"], new Date(0), NOW)).VTI).toHaveLength(300);
    expect(await broker.getAsset("AAPL")).toMatchObject({ symbol: "AAPL" });
    await broker.getCalendar("2026-11-02", "2026-11-02");
    const refused = [
      () => broker.getAccount(),
      () => broker.getAccountConfig(),
      () => broker.updateAccountConfig(),
      () => broker.getClock(),
      () => broker.getPositions(),
      () => broker.getOrders(),
      () => broker.getOrderByClientId(),
      () => broker.submitOrder(),
      () => broker.getActivities(),
    ];
    for (const call of refused) expect(call).toThrow(/reads market data only/);
  });

  it("is enough for every MCP tool: none of them needs the account or orders", async () => {
    const draft = strategy({ conviction: [thesis({ targetWeightPct: "10" })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } });
    await getOverview(deps);
    await getStrategy(deps);
    await getHoldings(deps);
    await getActivity(deps, 7);
    await getTrackRecord(deps);
    await getPrices(deps, ["AAPL"], 30);
    await checkEligibility(deps, ["AAPL", "VTI"]);
    await getExposure(deps, ["AAPL"]);
    await getWatchlist(deps);
    expect(await updateWatchlistTool(deps, [{ action: "watch", symbol: "AAPL", why: "a reason in a sentence", trigger: "a trigger in a sentence", revisitBy: "2026-12-01" , forecast: { beatVtiPct: 40, expectedExcessPct: "-2" }}])).toMatchObject({ status: "updated" });
    getRules();
    expect(await previewStrategy(deps, draft)).toMatchObject({ valid: true });
    expect(await submitStrategyTool(deps, draft)).toMatchObject({ status: "activated" });
  });
});
