import { describe, expect, it } from "vitest";
import { type DigestData, type NotifiableEvent, composeDigest, composeUrgent, escapeHtml, forecastLine } from "../../src/notifications/compose.js";

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
    expect(email.text).toContain("Nothing is bought or resized until you run risk:resume. A thesis that closes (its stop, its review date) or that Claude removes is still sold whole, and the cash waits.");
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
  it("says which holdings were trimmed to pay for a systematic buy, and what's still unfunded (#82)", () => {
    const funded = (uncovered: string) => composeDigest({ ...base, events: [ev("rebalance.buys_funded", { shortfall: "48.10", uncovered, sold: ["VTI", "XLF"] }, "XLK")] }, "production").text;
    expect(funded("0")).toContain("Sold VTI, XLF toward target to pay for XLK ($48.10 short in cash)");
    expect(funded("5.00")).toContain("Sold VTI, XLF toward target to pay for XLK ($48.10 short in cash; $5.00 still unfunded)");
  });

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
    expect(email.text).not.toContain("In plain terms");
  });

  it("lists each thesis in plain terms when it has a plain summary", () => {
    const plain = [{ symbol: "ROL", targetWeightPct: "5", text: "Rollins is the pest-control company behind Orkin." }];
    const email = composeUrgent([ev("strategy.activated", { version: 4, authoredBy: "claude", summary: "Adds ROL.", theses: 1, convictionPct: "5", topN: 1, universeSize: 1, plain }, "v4")], "production");
    expect(email.text).toContain("  In plain terms:\n  • ROL (5%): Rollins is the pest-control company behind Orkin.");
  });

  it("explains a rejection and what stays active", () => {
    const email = composeUrgent([ev("strategy.rejected", { authoredBy: "claude", errors: ["conviction[0].stopLossPct: must be at least 5 and at most 50"], activeVersion: 2 })], "production");
    expect(email.subject).toBe("Trader: Strategy rejected (claude's submission)");
    expect(email.text).toContain("• conviction[0].stopLossPct: must be at least 5 and at most 50");
    expect(email.text).toContain("v2 stays active.");
  });

  it("names a trailing stop and a profit target for what they are (#35)", () => {
    const trailing = composeUrgent([ev("thesis.stopped_out", { thesisId: "oxy-x", trigger: "trailing_stopped", reason: "OXY closed at $54.00, at or below its 10% trailing stop" }, "OXY")], "production");
    expect(trailing.subject).toBe("Trader: Trailing stop: selling OXY");
    const target = composeUrgent([ev("thesis.took_profit", { thesisId: "oxy-x", trigger: "took_profit", reason: "OXY closed at $80.00, at or above its 30% profit target ($78.00 vs $60.00 average cost)" }, "OXY")], "production");
    expect(target.subject).toBe("Trader: Profit target: selling OXY");
    expect(target.text).toContain("Thesis oxy-x is closed; re-entry needs a new thesis.");
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

  it("reports a thesis unwound at its review date", () => {
    const email = composeUrgent([ev("thesis.review_overdue", { thesisId: "lkq-director-cluster-2026q4", reason: "past its review date (2027-01-28) without a later one" }, "LKQ")], "production");
    expect(email.subject).toBe("Trader: Thesis unwound: LKQ (review date passed)");
    expect(email.text).toContain("Thesis lkq-director-cluster-2026q4 is past its review date (2027-01-28) without a later one, so it's sold into the systematic sleeve.");
  });
});

describe("filings (#105)", () => {
  const url = "https://www.sec.gov/Archives/edgar/data/1065696/000106569626000058/lkq-20261109.htm";
  it("emails a sell signal in a filing on a held name, saying nothing is sold automatically", () => {
    const email = composeUrgent(
      [ev("filing.sell_signal", { thesisId: "lkq-director-cluster", signal: "executive_departure", form: "8-K", filedOn: "2026-11-09", summary: "8-K: an officer or director change. It mentions someone resigning, retiring or leaving.", url }, "LKQ")],
      "production",
    );
    expect(email.subject).toBe("Trader: An officer or director is leaving: LKQ");
    expect(email.text).toContain(`Filed 2026-11-09: ${url}`);
    expect(email.text).toContain("It's a sell signal for thesis lkq-director-cluster. Nothing is sold automatically: Claude weighs it at the next research run.");
    expect(composeUrgent([ev("filing.sell_signal", { signal: "insider_sale" }, "BA")], "production").subject).toBe("Trader: An insider sold: BA");
  });

  it("lists the day's new filings in the digest, marking watchlist names and sell signals", () => {
    const email = composeDigest(
      {
        ...base,
        events: [
          ev("filings.noticed", {
            filings: [
              { symbol: "LKQ", thesisId: "lkq-1", form: "8-K", filedOn: "2026-11-09", summary: "8-K: results of operations.", sellSignal: null },
              { symbol: "CWST", thesisId: null, form: "4", filedOn: "2026-11-10", summary: "Form 4: Director Doe Jane sold 1000 shares.", sellSignal: "insider_sale" },
            ],
          }),
        ],
      },
      "production",
    );
    expect(email.text).toContain("SEC filings\n  LKQ, Mon Nov 9: 8-K: results of operations.\n  CWST (watchlist) [sell signal], Tue Nov 10: Form 4: Director Doe Jane sold 1000 shares.");
    expect(composeDigest(base, "production").text).not.toContain("SEC filings");
  });
});

describe("digest benchmark line", () => {
  it("shows performance vs VTI once there's a comparison", () => {
    const email = composeDigest({ ...base, benchmark: { since: "2026-11-02", portfolioPct: "1.24", benchmarkPct: "0.8" } }, "production");
    expect(email.text).toContain("Since Mon Nov 2: +1.24% vs VTI +0.8%");
    expect(composeDigest(base, "production").text).not.toContain("vs VTI");
  });
});

describe("digest watchlist section (#32)", () => {
  it("lists each name Claude started or kept watching, and each it dropped; nothing when there were no changes", () => {
    const email = composeDigest(
      {
        ...base,
        events: [
          ev("watchlist.updated", {
            watched: [
              { symbol: "UPBD", trigger: "Q4 guidance confirms the lease-to-own recovery", revisitBy: "2026-12-15", new: true },
              { symbol: "HGV", trigger: "a buyback after the Bluegreen integration", revisitBy: "2026-12-01", new: false },
            ],
            dropped: [{ symbol: "XYZ", why: "the catalyst passed without a move" }],
            open: 2,
          }),
        ],
      },
      "production",
    );
    expect(email.text).toContain("Research watchlist\n  Watching UPBD until 2026-12-15: Q4 guidance confirms the lease-to-own recovery\n  Still watching HGV until 2026-12-01: a buyback after the Bluegreen integration\n  Dropped XYZ: the catalyst passed without a move");
    expect(composeDigest(base, "production").text).not.toContain("Research watchlist");
  });
});

describe("digest lessons section (#28)", () => {
  it("lists each post-mortem with how the thesis ended and its excess over VTI; nothing without one", () => {
    const email = composeDigest(
      {
        ...base,
        events: [
          ev("lessons.recorded", {
            lessons: [
              { thesisId: "rol-family-buy-2026q4", symbol: "ROL", ending: "removed", excessPct: "1.09", lesson: "A family buy alone wasn't a business case.", replaced: false },
              { thesisId: "x-a", symbol: "XYZ", ending: "stopped", excessPct: null, lesson: "The stop was too tight for its volatility.", replaced: true },
            ],
          }),
        ],
      },
      "production",
    );
    expect(email.text).toContain("Lessons\n  ROL (removed, +1.09% vs VTI): A family buy alone wasn't a business case.\n  XYZ (stopped) [revised]: The stop was too tight for its volatility.");
    expect(composeDigest(base, "production").text).not.toContain("Lessons");
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

describe("capital emails", () => {
  it("explains a reversal, a canceled transfer and an unplanned outflow", () => {
    const email = composeUrgent(
      [
        ev("capital.transfer_reversed", { amount: "-1000", type: "CSD" }, "a-1"),
        ev("capital.transfer_canceled", { amount: "500", type: "CSD" }, "a-2"),
        ev("capital.unplanned_outflow", { amount: "-200", type: "CSW" }, "a-3"),
      ],
      "production",
      at,
    );
    expect(email.text).toContain("Transfer reversed: -$1000");
    expect(email.text).toContain("Transfer canceled: $500");
    expect(email.text).toContain("Trader leaves it out of performance on the assumption that no money moved.");
    expect(email.text).toContain("Money left the account: $200");
    expect(email.text).toContain("There was no withdrawal request");
  });

  it("lists the day's deposits and the money-weighted comparison in the digest", () => {
    const email = composeDigest(
      {
        ...base,
        events: [ev("capital.deposit_received", { amount: "500", type: "CSD" }, "a-1")],
        capital: { since: "2026-10-30", startValue: "1000", addedSince: "500", value: "1560.25", sameFlowsInVti: "1540.10" },
      },
      "production",
    );
    expect(email.text).toContain("Money in and out\n  Received $500 (invested at the next rebalance step)");
    expect(email.text).toContain("Since Fri Oct 30: started with $1000, net transfers $500, now $1560.25; the same money in VTI: $1540.10");
  });

  it("emails every withdrawal command, and when the money is ready", () => {
    const email = composeUrgent(
      [
        ev("capital.withdrawal_requested", { amount: "500", requestedBy: "cli", deadline: "2026-11-02T18:00:00.000Z" }, "w1"),
        ev("capital.command_rejected", { kind: "request", requestedBy: "dashboard:scott", reason: "a withdrawal is already open ($500, planning); cancel it first" }, "c2"),
        ev("capital.withdrawal_ready", { outstanding: "500", reason: "$510.00 of settled cash covers $500.00" }, "w1"),
      ],
      "production",
      at,
    );
    expect(email.text).toContain("You requested a withdrawal: $500");
    expect(email.text).toContain("Claude plans which holdings to sell by Mon, Nov 2, 1:00 PM ET");
    expect(email.text).toContain("Withdrawal command rejected (request)");
    expect(email.text).toContain("$500 is ready: withdraw it in Alpaca");
    expect(email.text).toContain("$510.00 of settled cash covers $500.00, so it should be withdrawable now.");
  });

  it("lists the open withdrawal in the digest every day until it closes", () => {
    const planning = composeDigest({ ...base, withdrawal: { status: "planning", amount: "500", outstanding: "500", unfunded: "500", planBy: "2026-11-02T18:00:00.000Z" } }, "production");
    expect(planning.text).toContain("Money in and out\n  Open withdrawal of $500: waiting for Claude's funding plan (by Mon, Nov 2, 1:00 PM ET); $500 still to raise. $500 is held back from investing.");
    const ready = composeDigest({ ...base, withdrawal: { status: "ready", amount: "all", outstanding: "998.20", unfunded: "0", planBy: null } }, "production");
    expect(ready.text).toContain("Open withdrawal of everything: ready: withdraw it in Alpaca. $998.20 is held back from investing.");
  });

  it("lists withdrawal progress in the digest", () => {
    const email = composeDigest(
      {
        ...base,
        events: [
          ev("capital.withdrawal_partial", { withdrawn: "200", remaining: "300" }, "w1"),
          ev("capital.withdrawal_completed", { withdrawn: "500" }, "w1"),
        ],
      },
      "production",
    );
    expect(email.text).toContain("Withdrew $200 so far; $300 still held for the request");
    expect(email.text).toContain("Withdrawal complete: $500 left the account");
  });

  it("leaves the money section out on a day without transfers", () => {
    expect(composeDigest(base, "production").text).not.toContain("Money in and out");
  });
});

describe("forecastLine", () => {
  const f = { resolvedThisWeek: 0, beatThisWeek: 0, backfilledThisWeek: 0, resolved: 0, skill: null, tooFewToJudge: true, baseRatePct: 45 };

  it("says too few to judge until there are enough", () => {
    expect(forecastLine(f)).toBe("Forecasts: none resolved this week; skill vs the 45% base rate: too few to judge (0 resolved)");
    expect(forecastLine({ ...f, resolvedThisWeek: 2, beatThisWeek: 1, backfilledThisWeek: 3, resolved: 12, skill: 0.08 })).toBe(
      "Forecasts: 2 resolved this week, 1 beat VTI (3 backfilled, not scored); skill vs the 45% base rate: too few to judge (12 resolved)",
    );
  });

  it("gives the signed skill score once there are", () => {
    expect(forecastLine({ ...f, resolvedThisWeek: 1, beatThisWeek: 1, resolved: 34, skill: 0.1234, tooFewToJudge: false })).toBe(
      "Forecasts: 1 resolved this week, 1 beat VTI; skill vs the 45% base rate: +0.12 over 34 resolved",
    );
    expect(forecastLine({ ...f, resolved: 30, skill: -0.05, tooFewToJudge: false })).toContain("skill vs the 45% base rate: -0.05 over 30 resolved");
  });
});
