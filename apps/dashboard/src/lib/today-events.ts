import type { TodayEvent } from "@trader/core";
import { formatPct, formatQty, formatUsd } from "./format";

/** What happened in the session, one plain sentence each (SPEC-dashboard Amendment 3: "What changed today"). */
export interface DescribedEvent {
  at: string;
  symbol: string | null;
  text: string;
  /** Worth noticing: an automatic sale, a guardrail, a sell-signal filing. */
  attention: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

export function describeEvent(e: TodayEvent): DescribedEvent {
  const p = e.payload;
  const symbol = e.kind === "events.tripped" ? str(p.symbol) : e.symbol;
  const reason = str(p.reason) ?? str(p.summary);
  const base = { at: e.at, symbol };
  switch (e.kind) {
    case "order.filled": {
      const qty = str(p.filledQty);
      const price = str(p.filledAvgPrice);
      const verb = p.side === "sell" ? "Sold" : "Bought";
      return { ...base, text: `${verb} ${qty ? `${formatQty(qty)} ` : ""}${e.symbol ?? ""}${price ? ` at ${formatUsd(price)}` : ""}`.trim(), attention: false };
    }
    case "strategy.activated":
      // The summary's first line is its headline, as in the activation email and get_activity.
      return { ...base, symbol: null, text: `Strategy v${String(p.version ?? "?")}: ${str(p.headline) ?? str(p.summary)?.split("\n")[0]?.trim() ?? "updated"}`, attention: false };
    case "thesis.stopped_out":
      return { ...base, text: `Sold ${e.symbol}: it closed through its stop${reason ? ` (${reason})` : ""}`, attention: true };
    case "thesis.took_profit":
      return { ...base, text: `Sold ${e.symbol}: it reached its profit target${reason ? ` (${reason})` : ""}`, attention: true };
    case "thesis.review_overdue":
      return { ...base, text: `Selling ${e.symbol}: its review date passed${reason ? ` (${reason})` : ""}`, attention: true };
    case "thesis.stale":
      return { ...base, text: `${e.symbol} went stale: not reaffirmed in 30 days`, attention: true };
    case "events.tripped": {
      const trigger = str(p.trigger);
      const pct = str(p.distancePct);
      const detail = str(p.detail);
      // The trip's own sentence already names the stock.
      if (detail) return { ...base, text: detail, attention: trigger === "near_stop" };
      const what = trigger === "near_stop" ? `near its stop${pct ? ` (${formatPct(pct, 2, false)} above)` : ""}` : trigger === "move" ? `moved ${pct ? formatPct(pct) : "8%+"} today` : "a sell-signal filing";
      return { ...base, text: `${symbol ?? "A holding"}: ${what}`, attention: trigger === "near_stop" };
    }
    case "routine.event_run_result":
      return { ...base, symbol: null, text: "A research run started to re-check the holdings that moved", attention: false };
    case "filing.sell_signal":
      return { ...base, text: `${e.symbol}: ${reason ?? "a sell-signal filing"}`, attention: true };
    case "risk.halted":
      return { ...base, symbol: null, text: `Trading halted${reason ? `: ${reason}` : ""}`, attention: true };
    case "risk.kill_switch_on":
      return { ...base, symbol: null, text: "The kill switch was turned on", attention: true };
    case "risk.resumed":
      return { ...base, symbol: null, text: "Trading resumed", attention: false };
    case "risk.buys_paused":
      return { ...base, symbol: null, text: `Buys paused for the day${reason ? `: ${reason}` : ""}`, attention: true };
    case "capital.deposit_received":
      return { ...base, symbol: null, text: `Deposit received${str(p.amount) ? `: ${formatUsd(str(p.amount)!)}` : ""}`, attention: false };
    case "capital.withdrawal_completed":
      return { ...base, symbol: null, text: "A withdrawal completed", attention: false };
    default:
      return { ...base, text: e.kind, attention: false };
  }
}
