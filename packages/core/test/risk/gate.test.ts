import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import { recordCapitalFlows } from "../../src/capital/ledger.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, brokerAccount, capitalCommands, equitySnapshots, jobRuns, riskDecisions, riskGateRuns, withdrawals } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { checkDrawdown, riskGate, roundTripBlocks } from "../../src/risk/gate.js";
import { LIMITS } from "../../src/risk/limits.js";
import { getRiskState, resume, setKillSwitch } from "../../src/risk/state.js";
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
    expect(rejected).toMatchObject({ subject: "TQQQ", payload: { reasons: ['TQQQ is leveraged or inverse: ProShares makes leveraged, inverse and volatility funds ("ProShares UltraPro QQQ").'] } });
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

describe("roundTripBlocks", () => {
  it("blocks today's fills on the opposite side, and nothing when round trips are allowed", async () => {
    broker.fill("o-1", "AAPL", "buy", "1", "230", new Date(NOW.getTime() - 10 * 60_000));
    broker.fill("o-2", "XLE", "sell", "2", "65", new Date(NOW.getTime() - 5 * 60_000));
    broker.fill("o-0", "MSFT", "buy", "1", "400", new Date(NOW.getTime() - 86_400_000)); // yesterday: free to sell
    await syncBroker(db, broker, "staging", NOW);
    const blocks = await roundTripBlocks(db, NOW);
    expect([...blocks.sell]).toEqual(["AAPL"]);
    expect([...blocks.buy]).toEqual(["XLE"]);
    expect(await roundTripBlocks(db, NOW, { ...LIMITS, sameDayRoundTrips: true })).toEqual({ sell: new Set(), buy: new Set() });
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

  it("latches the halt at 30% below peak, once, and recovery doesn't clear it", async () => {
    await snapshots(["2026-10-29", "1000"], ["2026-10-30", "1250"]);
    await db.update(brokerAccount).set({ equity: "999", lastEquity: "1250" });
    expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "20.08", halted: "no" });
    await db.update(brokerAccount).set({ equity: "874" });

    const first = await checkDrawdown(db, NOW);
    expect(first).toMatchObject({ drawdownPct: "30.08", halted: "tripped" });
    expect((await checkDrawdown(db, NOW)).halted).toBe("already");
    expect(await events("risk.halted")).toHaveLength(1);

    await db.update(brokerAccount).set({ equity: "1300" });
    await checkDrawdown(db, NOW);
    expect((await getRiskState(db)).halted).toBe(true);
  });

  it("after the owner resumes, halts again 15% below the level then, with a reason that says so (ADR-017)", async () => {
    // NOW is Monday 2026-11-02. Peak 1250 on Thursday, 31% down by Friday's close; resumed Friday evening.
    await snapshots(["2026-10-29", "1250"], ["2026-10-30", "862.5"]);
    await db.update(brokerAccount).set({ equity: "862.5", lastEquity: "862.5" });
    expect((await checkDrawdown(db, NOW)).halted).toBe("tripped");
    await resume(db, { actor: "owner", reason: "reviewed" }, new Date("2026-10-30T23:00:00Z"));

    await db.update(brokerAccount).set({ equity: "740" }); // 14.2% below the resume level
    expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "14.2029", halted: "no" });
    await db.update(brokerAccount).set({ equity: "733" }); // 15.01%
    expect(await checkDrawdown(db, NOW)).toMatchObject({ halted: "tripped" });
    expect((await getRiskState(db)).haltReason).toBe("the account is down 15.0145% since trading resumed on 2026-10-30 (limit 15% until it regains its old peak; 41.36% below that peak)");
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

  describe("a withdrawal's transfer in flight (cash left, Alpaca hasn't posted the CSW yet)", () => {
    async function openRequest(status: "funding" | "settling" | "ready", amount: string | null, raisedCash: string | null = null) {
      const [command] = await db.insert(capitalCommands).values({ kind: "request", amount: amount ?? "all", requestedBy: "cli" }).returning();
      await db.insert(withdrawals).values({ status, amount, raisedCash, commandId: command!.id, requestedAt: new Date("2026-11-02T14:00:00Z"), deadline: NOW, updatedAt: NOW });
    }
    const afterAch = (equity: string, cash: string) => db.update(brokerAccount).set({ equity, cash, lastEquity: "1000" });

    it("counts the missing reserved cash as money out, not a loss", async () => {
      await snapshots(["2026-10-30", "1000"]);
      await openRequest("ready", "500");
      await afterAch("500", "0");
      expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "0", dailyChangePct: "0", halted: "no", buysPaused: false });
    });

    it("does the same for all, against the cash it raised", async () => {
      await snapshots(["2026-10-30", "1000"]);
      await openRequest("ready", null, "1000");
      await afterAch("0.40", "0.40");
      expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "0", halted: "no" });
    });

    it("isn't counted twice once the transfer posts, before the request is matched", async () => {
      await snapshots(["2026-10-30", "1000"]);
      await openRequest("ready", "500");
      transfer("csw-1", "CSW", "-500", new Date("2026-11-02T14:30:00Z"));
      broker.account = { ...broker.account, equity: "500", cash: "0", lastEquity: "1000" };
      await syncBroker(db, broker, "staging", NOW);
      await recordCapitalFlows(db, NOW);
      expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "0", dailyChangePct: "0" });
    });

    it("covers only the reserved amount, and only once the cash was raised", async () => {
      await snapshots(["2026-10-30", "1000"]);
      await openRequest("ready", "100");
      await afterAch("750", "0"); // $100 out, and a real $150 loss on holdings
      expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "15", dailyChangePct: "-15", halted: "no" });

      ({ db } = await createTestDb());
      await syncBroker(db, broker, "staging", NOW);
      await snapshots(["2026-10-30", "1000"]);
      await openRequest("funding", "500"); // still selling: a fall in cash isn't a transfer yet
      await afterAch("500", "0");
      expect(await checkDrawdown(db, NOW)).toMatchObject({ drawdownPct: "50", halted: "tripped" });
    });
  });

  it("announces a daily-loss pause once and its recovery once", async () => {
    await db.update(brokerAccount).set({ equity: "940", lastEquity: "1000" });
    expect((await checkDrawdown(db, NOW)).buysPaused).toBe(false); // −6% is inside the 8% limit
    await db.update(brokerAccount).set({ equity: "910" });
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
