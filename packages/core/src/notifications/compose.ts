import type { TradingEnv } from "../env.js";
import { compare, sub } from "../money.js";
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

/** One sentence-level description per kind. Reasons already read as English (SPEC-risk). */
export function describe(e: NotifiableEvent): Described {
  const p = e.payload;
  switch (e.kind) {
    case "risk.halted":
      return {
        headline: "Trading HALTED",
        lines: [`Why: ${str(p.reason)}.`, "Every order is blocked, sells included, until you run risk:resume."],
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
        lines: [`${str(p.reason)}.`, "The rebalance sells to raise the cash; you'll get an email when it's ready to withdraw."],
      };
    case "capital.withdrawal_ready":
      return {
        headline: `${money(p.outstanding)} is ready: withdraw it in Alpaca`,
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
  /** Money-weighted: net deposits, today's value, and the same deposits held in VTI (SPEC-capital). */
  capital?: { contributed: string; value: string; sameFlowsInVti: string | null } | null;
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
  const capital = data.events.map(capitalLine).filter((l): l is string => l !== null);
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
        ...(data.capital
          ? [`Put in $${data.capital.contributed}, now $${data.capital.value}${data.capital.sameFlowsInVti ? `; the same deposits in VTI: $${data.capital.sameFlowsInVti}` : ""}`]
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
