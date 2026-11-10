import type { CapitalSummary } from "../capital/shadow.js";
import type { TradingEnv } from "../env.js";
import { compare, round, sub } from "../money.js";
import { formatMarketTime } from "../time.js";
import type { OutgoingEmail } from "./port.js";
import { SEVERITY } from "./routing.js";

/** The audit-event fields an email needs. */
export interface NotifiableEvent {
  kind: string;
  subject: string | null;
  payload: Record<string, unknown>;
  at: Date;
}

interface Described {
  headline: string;
  lines: string[];
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : v === undefined || v === null ? [] : [str(v)]);
/** The activation email's plain-language lines (#60), one per thesis that has a plainSummary. */
const plainLines = (v: unknown): string[] => {
  const rows = (Array.isArray(v) ? v : []) as { symbol?: unknown; targetWeightPct?: unknown; text?: unknown }[];
  return rows.length ? ["In plain terms:", ...rows.map((t) => `• ${str(t.symbol)} (${str(t.targetWeightPct)}%): ${str(t.text)}`)] : [];
};

/** One sentence-level description per kind. Reasons already read as English (SPEC-risk). */
export function describe(e: NotifiableEvent): Described {
  const p = e.payload;
  switch (e.kind) {
    case "risk.halted":
      return {
        headline: "Trading HALTED",
        lines: [`Why: ${str(p.reason)}.`, "Nothing is bought or resized until you run risk:resume. A thesis that closes (its stop, its review date) or that Claude removes is still sold whole, and the cash waits."],
      };
    case "risk.kill_switch_on":
      return { headline: "Kill switch ON", lines: [`Reason: ${str(p.reason)}.`, "Every order is blocked until risk:resume."] };
    case "risk.resumed":
      return { headline: "Trading resumed", lines: [`Cleared: ${list(p.cleared).join(", ")}.`, `Your reason: ${str(p.reason)}.`] };
    case "risk.buys_paused":
      return {
        headline: "Buys paused for today",
        lines: [`The account is down ${sub("0", str(p.dailyChangePct || "0"))}% since yesterday's close.`, "Sells still run. Buys resume tomorrow, or if it recovers above the limit."],
      };
    case "broker.config_unsafe":
    case "broker.account_changed":
    case "broker.reconcile_mismatch":
      return {
        headline: "Broker safety check failed",
        lines: [...list(p.reasons).map((r) => `• ${r}`), "Trading is blocked until this clears."],
      };
    case "broker.trading_allowed":
      return { headline: "Broker safety check passing again", lines: [`Cleared: ${list(p.cleared).join("; ")}.`] };
    case "order.external":
      return {
        headline: `Order placed outside Trader: ${str(e.subject)}`,
        lines: [`${str(p.side)} ${p.notional ? `$${str(p.notional)}` : `${str(p.qty)} sh`} ${str(e.subject)}, status ${str(p.status)}.`, "Trader didn't place this. It's now part of the account it manages."],
      };
    case "order.unknown":
      return {
        headline: `Order state unknown: ${str(e.subject)}`,
        lines: [`Client order ${str(p.clientOrderId)}${p.error ? `: ${str(p.error)}` : ""}.`, "sync-broker will resolve it by client id."],
      };
    case "job.failed": {
      const folded = Number(p.foldedCount ?? 0);
      return {
        headline: `Job failed: ${str(e.subject)}`,
        lines: [`Error: ${str(p.error)}`, ...(folded > 0 ? [`${folded} more failure(s) of this job since the last email.`] : [])],
      };
    }
    case "strategy.activated":
      return {
        headline: `New strategy v${str(p.version)} by ${str(p.authoredBy)}`,
        lines: [
          str(p.summary),
          ...plainLines(p.plain),
          `${str(p.theses)} conviction ${Number(p.theses) === 1 ? "thesis" : "theses"} (${str(p.convictionPct)}% of the account); systematic: top ${str(p.topN)} of ${str(p.universeSize)} symbols.`,
          "It takes effect at the next rebalance step.",
        ],
      };
    case "strategy.rejected":
      return {
        headline: `Strategy rejected (${str(p.authoredBy)}'s submission)`,
        lines: [...list(p.errors).map((err) => `• ${err}`), `v${str(p.activeVersion)} stays active.`],
      };
    case "thesis.stopped_out":
      return { headline: `Stop-loss: selling ${str(e.subject)}`, lines: [`${str(p.reason)}.`, `Thesis ${str(p.thesisId)} is closed; re-entry needs a new thesis.`] };
    case "thesis.stale":
      return {
        headline: `Thesis unwound: ${str(e.subject)} (not reviewed)`,
        lines: [`Thesis ${str(p.thesisId)} was ${str(p.reason)}, so it's sold into the systematic sleeve.`, "If research is running, this means Claude's strategy hasn't been resubmitted in 30 days."],
      };
    case "thesis.review_overdue":
      return {
        headline: `Thesis unwound: ${str(e.subject)} (review date passed)`,
        lines: [`Thesis ${str(p.thesisId)} is ${str(p.reason)}, so it's sold into the systematic sleeve.`, "A later version can bring it back by moving the review date on with fresh, dated evidence."],
      };
    case "capital.transfer_reversed":
      return {
        headline: `Transfer reversed: ${money(p.amount)}`,
        lines: [`Alpaca reversed an earlier ${str(p.type)} transfer (e.g. a returned instant ACH).`, "It's counted as money out, not as a loss. Check the bank side if you didn't expect it."],
      };
    case "capital.transfer_canceled":
      return {
        headline: `Transfer canceled: ${money(p.amount)}`,
        lines: [`Alpaca marked a ${str(p.type)} transfer canceled.`, "Trader leaves it out of performance on the assumption that no money moved. If equity says otherwise, tell Claude."],
      };
    case "capital.unplanned_outflow":
      return {
        headline: `Money left the account: ${money(sub("0", str(p.amount)))}`,
        lines: ["There was no withdrawal request for it. It's counted as a withdrawal, not as a loss.", "If you didn't move this money, check the Alpaca account now."],
      };
    case "capital.withdrawal_requested":
      return {
        headline: `You requested a withdrawal: ${p.amount === "all" ? "everything" : money(p.amount)}`,
        lines: [
          `Requested by ${str(p.requestedBy)}. That cash is now held back from investing.`,
          p.amount === "all"
            ? "Everything is sold over the next rebalance steps. You'll get an email when it's ready to withdraw."
            : `Claude plans which holdings to sell by ${when(p.deadline)}; after that the fallback sells from VTI and the systematic sleeve first. You'll get an email when it's ready to withdraw.`,
          "If you didn't ask for this, cancel it (capital:cancel or the dashboard) and check who has access.",
        ],
      };
    case "capital.fund_now":
      return { headline: `Funding your withdrawal now: ${p.amount === "all" ? "everything" : money(p.amount)}`, lines: [`Requested by ${str(p.requestedBy)}. The fallback plans the sells on the next tick instead of waiting for Claude.`] };
    case "capital.withdrawal_cancelled":
      return {
        headline: `Withdrawal cancelled: ${p.amount === "all" ? "everything" : money(p.amount)}`,
        lines: [`Requested by ${str(p.requestedBy)}, while it was ${str(p.was)}. The held-back cash is reinvested at the next rebalance step.`],
      };
    case "capital.command_rejected":
      return {
        headline: `Withdrawal command rejected (${str(p.kind)})`,
        lines: [`Why: ${str(p.reason)}.`, `Sent by ${str(p.requestedBy)}. Nothing changed.`],
      };
    case "capital.funding_planned":
      return {
        headline: `Withdrawal funding planned: ${p.amount === "all" ? "everything" : money(p.amount)}`,
        lines: [
          `${str(p.reason)}.`,
          ...(p.summary ? [`Why: ${str(p.summary)}`] : []),
          "The rebalance sells to raise the cash; you'll get an email when it's ready to withdraw.",
        ],
      };
    case "capital.withdrawal_ready":
      return {
        headline: `${money(p.withdrawable ?? p.outstanding)} is ready: withdraw it in Alpaca`,
        lines: [`${str(p.reason)}, so it should be withdrawable now.`, "Start the transfer in Alpaca. Trader matches it when it posts and closes the request. If Alpaca won't allow it yet, try again tomorrow."],
      };
    default:
      return { headline: e.kind, lines: [JSON.stringify(p)] };
  }
}

/** "$500", "-$1000": signed dollars from a decimal string. */
/** An ISO instant from a payload, as people read it. */
function when(v: unknown): string {
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? formatMarketTime(d) : str(v);
}

function money(v: unknown): string {
  const s = str(v);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `$${s}`;
}

function prefix(env: TradingEnv): string {
  return env === "staging" ? "[paper] " : "";
}

/**
 * Every email ends with when it was written, a definitive timestamp to
 * cross-check against arrival time. Only staging names its environment;
 * production is the default (Scott, 2026-11-01).
 */
export function footer(env: TradingEnv, at: Date): { text: string; html: string } {
  const line = `— Trader${env === "staging" ? " (staging)" : ""} · ${formatMarketTime(at)}`;
  return { text: `\n\n${line}\n`, html: `<p style="color:#666">${escapeHtml(line)}</p>` };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** One email for every urgent event in a tick, most severe first. */
export function composeUrgent(events: NotifiableEvent[], env: TradingEnv, at: Date = new Date()): OutgoingEmail {
  const sorted = [...events].sort(
    (a, b) => (SEVERITY[a.kind as keyof typeof SEVERITY] ?? 99) - (SEVERITY[b.kind as keyof typeof SEVERITY] ?? 99) || a.at.getTime() - b.at.getTime(),
  );
  const described = sorted.map((e) => ({ e, d: describe(e) }));
  const first = described[0]?.d.headline ?? "Notification";
  const more = described.length > 1 ? ` (+${described.length - 1} more)` : "";
  const subject = `${prefix(env)}Trader: ${first}${more}`;

  const text = described
    .map(({ e, d }) => [`${d.headline} (${formatMarketTime(e.at)})`, ...d.lines.map((l) => `  ${l}`)].join("\n"))
    .join("\n\n");
  const html = described
    .map(
      ({ e, d }) =>
        `<h3>${escapeHtml(d.headline)}</h3><p style="color:#666">${escapeHtml(formatMarketTime(e.at))}</p><ul>${d.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
    )
    .join("");
  const f = footer(env, at);
  return { subject, text: `${text}${f.text}`, html: `${html}${f.html}` };
}

export interface DigestData {
  date: string;
  equity: string;
  cash: string;
  dailyChangePct: string;
  drawdownPct: string;
  positions: { symbol: string; qty: string; marketValue: string }[];
  events: NotifiableEvent[];
  state: { killSwitch: boolean; halted: boolean; haltReason: string | null };
  /** Flow-adjusted performance vs VTI since the first snapshot (portfolio/benchmark.ts), once there are two. */
  benchmark?: { since: string; portfolioPct: string; benchmarkPct: string } | null;
  /** Money-weighted over the index's window: start value, transfers since, value at the close, the same money in VTI (SPEC-capital). */
  capital?: Pick<CapitalSummary, "since" | "startValue" | "addedSince" | "value" | "sameFlowsInVti"> | null;
  /** The open withdrawal request, listed every day until it closes (SPEC-capital). */
  withdrawal?: { status: string; amount: string; outstanding: string; unfunded: string; planBy: string | null } | null;
}

const WITHDRAWAL_STAGE: Record<string, string> = {
  planning: "waiting for Claude's funding plan",
  funding: "selling to raise the cash",
  settling: "cash raised, settling",
  ready: "ready: withdraw it in Alpaca",
};

/** The open request's one-line status for the digest. */
export function withdrawalLine(w: NonNullable<DigestData["withdrawal"]>): string {
  const what = w.amount === "all" ? "everything" : money(w.amount);
  const stage = w.status === "planning" && w.planBy ? `${WITHDRAWAL_STAGE.planning} (by ${when(w.planBy)})` : (WITHDRAWAL_STAGE[w.status] ?? w.status);
  const raise = compare(w.unfunded, "0") > 0 && w.status !== "ready" ? `; ${money(round(w.unfunded, 2, "up"))} still to raise` : "";
  return `Open withdrawal of ${what}: ${stage}${raise}. ${money(w.outstanding)} is held back from investing.`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function signed(pct: string): string {
  return compare(pct, "0") > 0 ? `+${pct}` : pct;
}

function tradeLine(e: NotifiableEvent): string | null {
  const p = e.payload;
  const sym = str(e.subject);
  switch (e.kind) {
    case "order.filled":
      return `${p.side === "sell" ? "Sold" : "Bought"} ${str(p.filledQty)} ${sym} @ $${str(p.filledAvgPrice)}`;
    case "order.partially_filled":
      return `Partially filled: ${str(p.filledQty)} ${sym} @ $${str(p.filledAvgPrice)} so far`;
    case "order.canceled":
      return `Canceled/expired: ${str(p.side)} ${sym} (${str(p.to)})`;
    case "order.rejected":
      return `Broker rejected an order for ${sym}: ${str(p.reason)}`;
    case "rebalance.buys_funded":
      return `Sold ${list(p.sold).join(", ")} toward target to pay for ${sym} ($${str(p.shortfall)} short in cash${p.uncovered && p.uncovered !== "0" ? `; $${str(p.uncovered)} still unfunded` : ""})`;
    default:
      return null;
  }
}

function capitalLine(e: NotifiableEvent): string | null {
  const p = e.payload;
  switch (e.kind) {
    case "capital.deposit_received":
      return `Received ${money(p.amount)} (invested at the next rebalance step)`;
    case "capital.withdrawal_settling":
      return `Withdrawal: the cash is raised; ${str(p.reason).split("; ").at(-1)}`;
    case "capital.withdrawal_partial":
      return `Withdrew ${money(p.withdrawn)} so far; ${money(p.remaining)} still held for the request`;
    case "capital.withdrawal_completed":
      return `Withdrawal complete: ${money(p.withdrawn)} left the account`;
    default:
      return null;
  }
}

function guardrailLine(e: NotifiableEvent): string | null {
  const p = e.payload;
  switch (e.kind) {
    case "risk.order_clipped":
      return `Clipped ${str(p.side)} ${str(e.subject)} $${str(p.requested)} → $${str(p.approved)}: ${list(p.reasons).join(" ")}`;
    case "risk.order_rejected":
      return `Rejected ${str(p.side)} ${str(e.subject)}: ${list(p.reasons).join(" ")}`;
    case "risk.buys_resumed":
      return `Buys resumed (account at ${str(p.dailyChangePct)}% today)`;
    default:
      return null;
  }
}

/** The once-per-trading-day summary. Sent on quiet days too: its arrival means "alive". */
export function composeDigest(data: DigestData, env: TradingEnv, at: Date = new Date()): OutgoingEmail {
  const fills = data.events.filter((e) => e.kind === "order.filled").length;
  const subject = `${prefix(env)}Trader daily: ${signed(data.dailyChangePct)}%, ${fills} ${fills === 1 ? "trade" : "trades"} (${shortDate(data.date)})`;

  const trades = data.events.map(tradeLine).filter((l): l is string => l !== null);
  const guardrails = data.events.map(guardrailLine).filter((l): l is string => l !== null);
  const capital = [...(data.withdrawal ? [withdrawalLine(data.withdrawal)] : []), ...data.events.map(capitalLine).filter((l): l is string => l !== null)];
  const status = data.state.killSwitch
    ? "KILL SWITCH ON: all trading blocked"
    : data.state.halted
      ? `HALTED: ${data.state.haltReason ?? "drawdown limit"}`
      : `Normal: drawdown ${data.drawdownPct}% from peak`;

  const sections: [string, string[]][] = [
    [
      "Account",
      [
        `Equity $${data.equity} (${signed(data.dailyChangePct)}% today, flow-adjusted)`,
        ...(data.benchmark
          ? [`Since ${shortDate(data.benchmark.since)}: ${signed(data.benchmark.portfolioPct)}% vs VTI ${signed(data.benchmark.benchmarkPct)}%`]
          : []),
        ...(data.capital?.since && data.capital.startValue && data.capital.value
          ? [
              `Since ${shortDate(data.capital.since)}: started with $${data.capital.startValue}${compare(data.capital.addedSince, "0") !== 0 ? `, net transfers $${data.capital.addedSince}` : ""}, now $${data.capital.value}${data.capital.sameFlowsInVti ? `; the same money in VTI: $${data.capital.sameFlowsInVti}` : ""}`,
            ]
          : []),
        `Cash $${data.cash}`,
        `Guardrails: ${status}`,
      ],
    ],
    ["Positions", data.positions.length ? data.positions.map((p) => `${p.symbol}: ${p.qty} sh, $${p.marketValue}`) : ["None (all cash)"]],
    ...(capital.length ? ([["Money in and out", capital]] as [string, string[]][]) : []),
    ["Trades", trades.length ? trades : ["None today"]],
    ["Guardrail decisions", guardrails.length ? guardrails : ["None today"]],
  ];

  const text = sections.map(([h, lines]) => [h, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n\n");
  const html = sections.map(([h, lines]) => `<h3>${escapeHtml(h)}</h3><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`).join("");
  const f = footer(env, at);
  return {
    subject,
    text: `Trader daily summary for ${shortDate(data.date)}

${text}${f.text}`,
    html: `<h2>Trader daily summary for ${escapeHtml(shortDate(data.date))}</h2>${html}${f.html}`,
  };
}

/** What the Friday letter reports (#38): built by notifications/weekly.ts from existing readers. */
export interface WeeklyData {
  /** The week's Monday. */
  weekOf: string;
  /** The week's last session. */
  through: string;
  equity: string;
  /** Flow-adjusted return vs VTI's over the week's sessions; null without two snapshots. */
  week: { portfolioPct: string; benchmarkPct: string } | null;
  /** Since the first snapshot (the digest's figures). */
  sinceStart: { since: string; portfolioPct: string; benchmarkPct: string } | null;
  /** The scorecard's roll-ups (portfolio/scorecard.ts). */
  trackRecord: {
    overall: { theses: number; scored: number; excess: string; excessPct: string | null; beatVtiPct: string | null };
    byKind: { kind: string; theses: number; excessPct: string | null }[];
  };
  /** `plainSummary` from the latest version that lists the thesis (#60), when it has one. */
  opened: { symbol: string; thesisId: string; primaryKind: string | null; plainSummary?: string }[];
  closed: { symbol: string; thesisId: string; ending: string; excessPct: string | null; daysHeld: number }[];
  /** Strategy versions activated this week, with their summaries' first line. */
  /** Versions that changed the strategy; resubmissions that only reaffirmed it are counted in `reaffirmed`. */
  strategies: { version: number; authoredBy: string; headline: string }[];
  reaffirmed: number;
  /** Automatic exits this week (thesis_events). */
  exits: { kind: string; symbol: string; thesisId: string; reason: string }[];
  /** Review dates in the next 14 days. */
  reviews: { symbol: string; thesisId: string; reviewBy: string }[];
  state: { killSwitch: boolean; halted: boolean; haltReason: string | null; drawdownPct: string };
}

/** The Friday letter (#38): the week vs VTI, the track record, the week's decisions, and what's coming up. */
export function composeWeekly(data: WeeklyData, env: TradingEnv, at: Date = new Date()): OutgoingEmail {
  const vs = data.week ? `${signed(data.week.portfolioPct)}% vs VTI ${signed(data.week.benchmarkPct)}%` : "no full week yet";
  const subject = `${prefix(env)}Trader weekly: ${vs} (week of ${shortDate(data.weekOf)})`;
  const status = data.state.killSwitch
    ? "KILL SWITCH ON: all trading blocked"
    : data.state.halted
      ? `HALTED: ${data.state.haltReason ?? "drawdown limit"}`
      : `Normal: drawdown ${data.state.drawdownPct}% from peak`;
  const t = data.trackRecord.overall;
  const pct = (v: string | null) => (v === null ? "–" : `${signed(v)}%`);

  const sections: [string, string[]][] = [
    [
      "Performance",
      [
        `This week (through ${shortDate(data.through)}): ${vs}, flow-adjusted`,
        ...(data.sinceStart ? [`Since ${shortDate(data.sinceStart.since)}: ${signed(data.sinceStart.portfolioPct)}% vs VTI ${signed(data.sinceStart.benchmarkPct)}%`] : []),
        `Equity $${data.equity}`,
      ],
    ],
    [
      "Track record (each thesis vs the same dollars in VTI)",
      t.theses === 0
        ? ["No theses yet"]
        : [
            `${t.theses} theses (${t.scored} scored): ${money(t.excess)} vs VTI (${pct(t.excessPct)}); ${t.beatVtiPct === null ? "–" : `${t.beatVtiPct}%`} beat VTI`,
            ...data.trackRecord.byKind.map((k) => `${k.kind}: ${k.theses} ${k.theses === 1 ? "thesis" : "theses"}, ${pct(k.excessPct)} vs VTI`),
          ],
    ],
    [
      "This week's strategy changes",
      [
        ...(data.strategies.length ? data.strategies.map((s) => `v${s.version} (${s.authoredBy}): ${s.headline}`) : [data.reaffirmed ? "None" : "None: the strategy wasn't resubmitted this week"]),
        ...(data.reaffirmed ? [`Reaffirmed unchanged ${data.reaffirmed} ${data.reaffirmed === 1 ? "time" : "times"}`] : []),
      ],
    ],
    [
      "Theses opened",
      data.opened.length
        ? data.opened.flatMap((o) => [`${o.symbol} (${o.thesisId}${o.primaryKind ? `, ${o.primaryKind}` : ""})`, ...(o.plainSummary ? [`  ${o.plainSummary}`] : [])])
        : ["None"],
    ],
    [
      "Theses closed",
      data.closed.length ? data.closed.map((c) => `${c.symbol} (${c.thesisId}): ${c.ending} after ${c.daysHeld} days, ${pct(c.excessPct)} vs VTI`) : ["None"],
    ],
    ...(data.exits.length ? ([["Automatic exits", data.exits.map((e) => `${e.symbol} (${e.thesisId}), ${e.kind}: ${e.reason}`)]] as [string, string[]][]) : []),
    ["Review dates in the next 14 days", data.reviews.length ? data.reviews.map((r) => `${r.symbol} (${r.thesisId}): ${shortDate(r.reviewBy)}`) : ["None"]],
    ["Guardrails", [status]],
  ];

  const text = sections.map(([h, lines]) => [h, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n\n");
  const html = sections.map(([h, lines]) => `<h3>${escapeHtml(h)}</h3><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`).join("");
  const f = footer(env, at);
  return {
    subject,
    text: `Trader weekly letter, week of ${shortDate(data.weekOf)}\n\n${text}${f.text}`,
    html: `<h2>Trader weekly letter, week of ${escapeHtml(shortDate(data.weekOf))}</h2>${html}${f.html}`,
  };
}
