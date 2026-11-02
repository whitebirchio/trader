import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import { recordCapitalFlows } from "../../src/capital/ledger.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, brokerAccount, equitySnapshots, jobRuns, riskDecisions, riskGateRuns } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { checkDrawdown, riskGate } from "../../src/risk/gate.js";
import { getRiskState, setKillSwitch } from "../../src/risk/state.js";
import type { Proposal } from "../../src/risk/types.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { FakeMailer } from "../notifications/fake-mailer.js";
import { createTestDb } from "../helpers.js";
import { marketTimeToUtc } from "../../src/time.js";

let db: Db;
let broker: FakeBroker;
const NOW = new Date("2026-11-02T15:00:00Z");

function history(price: string, days = 100): Bar[] {
  return Array.from({ length: days }, (_, i) => ({
    t: new Date(NOW.getTime() - (days - i) * 86_400_000),
    o: price,
    h: price,
    l: price,
    c: price,
    v: "1000000",
  }));
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  broker.now = NOW;
  broker.assets.push(
    { symbol: "AAPL", name: "Apple Inc. Common Stock", status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" },
    { symbol: "TQQQ", name: "ProShares UltraPro QQQ", status: "active", tradable: true, fractionable: true, marginRequirementLong: "75" },
  );
  broker.bars = { VTI: history("300"), AAPL: history("230"), TQQQ: history("80") };
  await syncBroker(db, broker, "staging", NOW);
});

const buy = (symbol: string, notional: string, sleeve: "systematic" | "conviction" = "systematic"): Proposal => ({
  key: `plan-1:${symbol}:buy`,
  symbol,
  side: "buy",
  sleeve,
  notional,
});
const events = async (kind: string) => (await db.select().from(auditEvents)).filter((e) => e.kind === kind);

describe("riskGate", () => {
  it("evaluates against the synced account, persists the run and every decision, and audits only clips and rejections", async () => {
    const { gateRunId, decisions } = await riskGate(
      db,
      broker,
      [buy("VTI", "100"), buy("AAPL", "300", "conviction"), buy("TQQQ", "20", "conviction")],
      NOW,
    );
    expect(decisions.map((d) => [d.proposal.symbol, d.verdict, d.notional ?? null])).toEqual([
      ["VTI", "approved", "100"],
      ["AAPL", "clipped", "200"],
      ["TQQQ", "rejected", null],
    ]);

    const [run] = await db.select().from(riskGateRuns);
    expect(run?.id).toBe(gateRunId);
    expect(run?.limitsVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(run?.snapshot).toMatchObject({ equity: "1000", cash: "1000" });

    const rows = await db.select().from(riskDecisions);
    expect(rows.map((r) => [r.symbol, r.verdict, r.requestedNotional, r.approvedNotional])).toEqual([
      ["VTI", "approved", "100", "100"],
      ["AAPL", "clipped", "300", "200"],
      ["TQQQ", "rejected", "20", null],
    ]);

    expect(await events("risk.order_clipped")).toHaveLength(1);
    const [rejected] = await events("risk.order_rejected");
    expect(rejected).toMatchObject({ subject: "TQQQ", payload: { reasons: ["TQQQ is leveraged or inverse (margin requirement 75%)."] } });
  });

  it("rejects everything when the last sync is stale", async () => {
    const later = new Date(NOW.getTime() + 30 * 60_000);
    const { decisions } = await riskGate(db, broker, [buy("VTI", "50")], later);
    expect(decisions[0]?.reasons).toEqual(["Broker data is 30 minutes old (limit 20)."]);
  });

  it("rejects everything before the broker has ever been synced", async () => {
    ({ db } = await createTestDb());
    const { decisions } = await riskGate(db, broker, [buy("VTI", "50")], NOW);
    expect(decisions[0]?.verdict).toBe("rejected");
    expect(decisions[0]?.reasons[0]).toMatch(/broker safety check failed: the broker has never been synced/);
  });

  it("honours the kill switch", async () => {
    await setKillSwitch(db, { actor: "owner", reason: "investigating" }, NOW);
    const { decisions } = await riskGate(db, broker, [buy("VTI", "50")], NOW);
    expect(decisions[0]?.reasons[0]).toMatch(/^The kill switch is on \(investigating\)/);
  });

  it("treats holdings without a sleeve as conviction", async () => {
    broker.fill("o-1", "AAPL", "buy", "1.2", "230");
    broker.positions = [{ symbol: "AAPL", qty: "1.2", avgEntryPrice: "230", marketValue: "276", costBasis: "276", currentPrice: "230" }];
    await syncBroker(db, broker, "staging", NOW);
    // $276 of unattributed AAPL counts toward the $300 conviction cap.
    const { decisions } = await riskGate(db, broker, [buy("VTI", "1", "systematic"), buy("AAPL", "100", "conviction")], NOW);
    expect(decisions[1]).toMatchObject({ verdict: "rejected" });
  });
});

describe("checkDrawdown", () => {
  async function snapshots(...rows: [string, string][]) {
    await db.insert(equitySnapshots).values(
      rows.map(([tradingDate, equity]) => ({ tradingDate, equity, cash: equity, longMarketValue: "0", recordedAt: marketTimeToUtc(tradingDate, "16:15") })),
    );
  }

  function transfer(id: string, type: string, netAmount: string, at: Date, status = "executed") {
    broker.activities.push({ id, type, at, symbol: null, side: null, qty: null, price: null, netAmount, orderId: null, raw: { created_at: at.toISOString(), status } });
  }

  it("latches the halt at 20% below peak, once, and recovery doesn't clear it", async () => {
    await snapshots(["2026-10-29", "1000"], ["2026-10-30", "1250"]);
    await db.update(brokerAccount).set({ equity: "999", lastEquity: "1250" });

    const first = await checkDrawdown(db, NOW);
    expect(first).toMatchObject({ drawdownPct: "20.08", halted: "tripped" });
    expect((await checkDrawdown(db, NOW)).halted).toBe("already");
    expect(await events("risk.halted")).toHaveLength(1);

    await db.update(brokerAccount).set({ equity: "1300" });
    await checkDrawdown(db, NOW);
    expect((await getRiskState(db)).halted).toBe(true);
  });

  it("doesn't count a deposit as a gain or a withdrawal as a loss", async () => {
    await snapshots(["2026-10-30", "1000"]);
    transfer("csw-1", "CSW", "-500", new Date("2026-11-02T14:00:00Z"));
    broker.account = { ...broker.account, equity: "500", cash: "500", lastEquity: "1000" };
    await syncBroker(db, broker, "staging", NOW);
    await recordCapitalFlows(db, NOW);
    expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "0", dailyChangePct: "0", halted: "no", buysPaused: false });
  });

  it("doesn't halt after a deposit as large as the account that lands after a snapshot (the false-halt bug)", async () => {
    // Friday 20:00 ET, after Friday's 16:15 snapshot. Matching flows by date
    // subtracted it from Friday's step, whose equity never held it: index 0,
    // a 100% "drawdown" and a latched halt.
    await snapshots(["2026-10-29", "1000"], ["2026-10-30", "1000"]);
    transfer("csd-1", "CSD", "1000", marketTimeToUtc("2026-10-30", "20:00"));
    broker.account = { ...broker.account, equity: "2000", cash: "2000", lastEquity: "1000" };
    await syncBroker(db, broker, "staging", NOW);
    await recordCapitalFlows(db, NOW);
    expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "0", dailyChangePct: "0", halted: "no", buysPaused: false });
  });

  it("leaves a canceled transfer out of the measures", async () => {
    await snapshots(["2026-10-30", "1000"]);
    transfer("csd-x", "CSD", "1000", new Date("2026-11-02T14:00:00Z"), "canceled");
    await syncBroker(db, broker, "staging", NOW);
    await recordCapitalFlows(db, NOW);
    expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "0", dailyChangePct: "0", halted: "no" });
  });

  it("announces a daily-loss pause once and its recovery once", async () => {
    await db.update(brokerAccount).set({ equity: "940", lastEquity: "1000" });
    expect((await checkDrawdown(db, NOW)).buysPaused).toBe(true);
    await checkDrawdown(db, NOW);
    await db.update(brokerAccount).set({ equity: "990" });
    expect((await checkDrawdown(db, NOW)).buysPaused).toBe(false);
    expect(await events("risk.buys_paused")).toHaveLength(1);
    expect(await events("risk.buys_resumed")).toHaveLength(1);
  });

  it("runs as part of every sync-broker job", async () => {
    await runJob({ db, env: "staging", broker, mailer: new FakeMailer(), now: () => NOW }, "sync-broker", new Date("2026-11-02T15:00:00Z"));
    const [run] = (await db.select().from(jobRuns)).filter((r) => r.job === "sync-broker");
    expect(run?.status).toBe("succeeded");
    expect(run?.detail).toMatchObject({ risk: { drawdownPct: "0", halted: "no", buysPaused: false } });
  });
});
