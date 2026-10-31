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
    default:
      return { headline: e.kind, lines: [JSON.stringify(p)] };
  }
}

function prefix(env: TradingEnv): string {
  return env === "staging" ? "[paper] " : "";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** One email for every urgent event in a tick, most severe first. */
export function composeUrgent(events: NotifiableEvent[], env: TradingEnv): OutgoingEmail {
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
  return { subject, text: `${text}\n\n— Trader (${env})\n`, html: `${html}<p style="color:#666">— Trader (${escapeHtml(env)})</p>` };
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
export function composeDigest(data: DigestData, env: TradingEnv): OutgoingEmail {
  const fills = data.events.filter((e) => e.kind === "order.filled").length;
  const subject = `${prefix(env)}Trader daily: ${signed(data.dailyChangePct)}%, ${fills} ${fills === 1 ? "trade" : "trades"} (${shortDate(data.date)})`;

  const trades = data.events.map(tradeLine).filter((l): l is string => l !== null);
  const guardrails = data.events.map(guardrailLine).filter((l): l is string => l !== null);
  const status = data.state.killSwitch
    ? "KILL SWITCH ON: all trading blocked"
    : data.state.halted
      ? `HALTED: ${data.state.haltReason ?? "drawdown limit"}`
      : `Normal: drawdown ${data.drawdownPct}% from peak`;

  const sections: [string, string[]][] = [
    ["Account", [`Equity $${data.equity} (${signed(data.dailyChangePct)}% today, flow-adjusted)`, `Cash $${data.cash}`, `Guardrails: ${status}`]],
    ["Positions", data.positions.length ? data.positions.map((p) => `${p.symbol}: ${p.qty} sh, $${p.marketValue}`) : ["None (all cash)"]],
    ["Trades", trades.length ? trades : ["None today"]],
    ["Guardrail decisions", guardrails.length ? guardrails : ["None today"]],
  ];

  const text = sections.map(([h, lines]) => [h, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n\n");
  const html = sections.map(([h, lines]) => `<h3>${escapeHtml(h)}</h3><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`).join("");
  return {
    subject,
    text: `Trader daily summary for ${shortDate(data.date)}\n\n${text}\n\n— Trader (${env})\n`,
    html: `<h2>Trader daily summary for ${escapeHtml(shortDate(data.date))}</h2>${html}<p style="color:#666">— Trader (${escapeHtml(env)})</p>`,
  };
}
