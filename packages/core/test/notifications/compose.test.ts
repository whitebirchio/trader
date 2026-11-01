import { describe, expect, it } from "vitest";
import { type DigestData, type NotifiableEvent, composeDigest, composeUrgent, escapeHtml } from "../../src/notifications/compose.js";

const at = new Date("2026-11-02T20:15:00Z");
const ev = (kind: string, payload: Record<string, unknown>, subject: string | null = null): NotifiableEvent => ({ kind, subject, payload, at });

describe("composeUrgent", () => {
  it("leads with the halt and says what it means", () => {
    const email = composeUrgent(
      [ev("risk.halted", { reason: "the account is down 20.08% from its peak (limit 20%)" })],
      "production",
    );
    expect(email.subject).toBe("Trader: Trading HALTED");
    expect(email.text).toContain("Why: the account is down 20.08% from its peak (limit 20%).");
    expect(email.text).toContain("Every order is blocked, sells included, until you run risk:resume.");
    expect(email.html).toContain("<h3>Trading HALTED</h3>");
  });

  it("groups a tick's events into one email, most severe first", () => {
    const email = composeUrgent(
      [
        ev("risk.buys_paused", { dailyChangePct: "-5.4" }),
        ev("broker.config_unsafe", { reasons: ["margin multiplier 2 (must be 1)"] }),
        ev("risk.kill_switch_on", { reason: "investigating" }),
      ],
      "production",
    );
    expect(email.subject).toBe("Trader: Kill switch ON (+2 more)");
    const order = ["Kill switch ON", "Broker safety check failed", "Buys paused for today"].map((h) => email.text.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(email.text).toContain("• margin multiplier 2 (must be 1)");
  });

  it("describes an order placed outside Trader", () => {
    const email = composeUrgent([ev("order.external", { side: "buy", qty: "1", status: "filled" }, "AAPL")], "production");
    expect(email.subject).toBe("Trader: Order placed outside Trader: AAPL");
    expect(email.text).toContain("buy 1 sh AAPL, status filled.");
  });

  it("reports folded job failures", () => {
    const email = composeUrgent([ev("job.failed", { error: "fetch failed", foldedCount: 3 }, "sync-broker")], "production");
    expect(email.subject).toBe("Trader: Job failed: sync-broker");
    expect(email.text).toContain("3 more failure(s) of this job since the last email.");
  });

  it("prefixes staging", () => {
    expect(composeUrgent([ev("risk.kill_switch_on", { reason: "x" })], "staging").subject).toBe("[paper] Trader: Kill switch ON");
  });

  it("escapes untrusted text in HTML", () => {
    const email = composeUrgent([ev("order.external", { side: "buy", qty: "1", status: "<script>" }, "<b>X</b>")], "production");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(escapeHtml(`a&b"'`)).toBe("a&amp;b&quot;&#39;");
  });
});

const base: DigestData = {
  date: "2026-11-02",
  equity: "1004.20",
  cash: "694.20",
  dailyChangePct: "0.42",
  drawdownPct: "0",
  positions: [{ symbol: "VTI", qty: "1.012", marketValue: "310" }],
  events: [],
  state: { killSwitch: false, halted: false, haltReason: null },
};

describe("composeDigest", () => {
  it("summarizes a busy day", () => {
    const email = composeDigest(
      {
        ...base,
        events: [
          ev("order.submitted", { side: "buy" }, "VTI"),
          ev("order.filled", { side: "buy", filledQty: "1.012", filledAvgPrice: "306.32" }, "VTI"),
          ev("risk.order_clipped", { side: "buy", requested: "300", approved: "200", reasons: ["Reduced to keep AAPL within 20% of equity ($200)."] }, "AAPL"),
          ev("risk.order_rejected", { side: "buy", reasons: ["TQQQ is leveraged or inverse (margin requirement 75%)."] }, "TQQQ"),
        ],
      },
      "production",
    );
    expect(email.subject).toBe("Trader daily: +0.42%, 1 trade (Mon Nov 2)");
    expect(email.text).toContain("Equity $1004.20 (+0.42% today, flow-adjusted)");
    expect(email.text).toContain("VTI: 1.012 sh, $310");
    expect(email.text).toContain("Bought 1.012 VTI @ $306.32");
    expect(email.text).toContain("Clipped buy AAPL $300 → $200: Reduced to keep AAPL within 20% of equity ($200).");
    expect(email.text).toContain("Rejected buy TQQQ: TQQQ is leveraged or inverse (margin requirement 75%).");
    expect(email.text).toContain("Guardrails: Normal: drawdown 0% from peak");
  });

  it("still sends on a quiet day", () => {
    const email = composeDigest({ ...base, dailyChangePct: "-0.31", positions: [] }, "production");
    expect(email.subject).toBe("Trader daily: -0.31%, 0 trades (Mon Nov 2)");
    expect(email.text).toContain("None (all cash)");
    expect(email.text).toContain("Trades\n  None today");
  });

  it("puts a halt in the account section", () => {
    const email = composeDigest({ ...base, state: { killSwitch: false, halted: true, haltReason: "down 21% from peak" } }, "production");
    expect(email.text).toContain("Guardrails: HALTED: down 21% from peak");
  });
});

describe("composeDigest trade lines", () => {
  it("words a broker rejection without a side", () => {
    const email = composeDigest({ ...base, events: [ev("order.rejected", { reason: "insufficient buying power" }, "VTI")] }, "production");
    expect(email.text).toContain("Broker rejected an order for VTI: insufficient buying power");
  });
});

describe("buys paused wording", () => {
  it("says 'down', with the time in New York", () => {
    const email = composeUrgent([{ kind: "risk.buys_paused", subject: null, payload: { dailyChangePct: "-5.3" }, at: new Date("2026-11-03T15:15:00Z") }], "production");
    expect(email.text).toContain("Buys paused for today (Tue, Nov 3, 10:15 AM ET)");
    expect(email.text).toContain("The account is down 5.3% since yesterday's close.");
  });
});

describe("strategy and thesis emails", () => {
  it("announces a new strategy", () => {
    const email = composeUrgent(
      [ev("strategy.activated", { version: 3, authoredBy: "claude", summary: "Rotate into semis on capex guidance.", theses: 2, convictionPct: "35", topN: 4, universeSize: 40 }, "v3")],
      "production",
    );
    expect(email.subject).toBe("Trader: New strategy v3 by claude");
    expect(email.text).toContain("2 conviction theses (35% of the account); systematic: top 4 of 40 symbols.");
  });

  it("explains a rejection and what stays active", () => {
    const email = composeUrgent([ev("strategy.rejected", { authoredBy: "claude", errors: ["conviction[0].stopLossPct: must be at least 5 and at most 50"], activeVersion: 2 })], "production");
    expect(email.subject).toBe("Trader: Strategy rejected (claude's submission)");
    expect(email.text).toContain("• conviction[0].stopLossPct: must be at least 5 and at most 50");
    expect(email.text).toContain("v2 stays active.");
  });

  it("reports a stop-loss sale and a stale thesis, the stop first", () => {
    const email = composeUrgent(
      [
        ev("thesis.stale", { thesisId: "lmt-congress", reason: "not reaffirmed for 31 days (limit 30)" }, "LMT"),
        ev("thesis.stopped_out", { thesisId: "oxy-berkshire", reason: "OXY closed at $48.90, at or below its 20% stop ($49.60 vs $62.00 average cost)" }, "OXY"),
      ],
      "production",
    );
    expect(email.subject).toBe("Trader: Stop-loss: selling OXY (+1 more)");
    expect(email.text).toContain("Thesis lmt-congress was not reaffirmed for 31 days (limit 30), so it's sold into the systematic sleeve.");
  });
});

describe("digest benchmark line", () => {
  it("shows performance vs VTI once there's a comparison", () => {
    const email = composeDigest({ ...base, benchmark: { since: "2026-11-02", portfolioPct: "1.24", benchmarkPct: "0.8" } }, "production");
    expect(email.text).toContain("Since Mon Nov 2: +1.24% vs VTI +0.8%");
    expect(composeDigest(base, "production").text).not.toContain("vs VTI");
  });
});

describe("footer", () => {
  const at = new Date("2026-11-02T14:45:00Z");
  it("ends every email with its time; only staging names the environment", () => {
    const prod = composeUrgent([ev("risk.kill_switch_on", { reason: "x" })], "production", at);
    expect(prod.text.trimEnd().split("\n").at(-1)).toBe("— Trader · Mon, Nov 2, 9:45 AM ET");
    const stg = composeDigest(base, "staging", at);
    expect(stg.text.trimEnd().split("\n").at(-1)).toBe("— Trader (staging) · Mon, Nov 2, 9:45 AM ET");
    expect(stg.html).toContain("— Trader (staging) · Mon, Nov 2, 9:45 AM ET");
  });
});
