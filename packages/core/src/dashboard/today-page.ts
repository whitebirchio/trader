/**
 * Everything the Today page shows (SPEC-dashboard Amendment 3), in one read:
 * the last session's move, the pre-market or after-hours line, the
 * since-start summary, the guardrails, each holding's headline and the
 * "where the money is" diagram. Database only.
 */
import type { Db } from "../db/client.js";
import type { TradingEnv } from "../env.js";
import { add, sub } from "../money.js";
import { dayValues } from "../portfolio/position-history.js";
import { activeStrategy } from "../portfolio/store.js";
import { type Headline, headlineOf } from "./headlines.js";
import { type RangeFigures, performanceView } from "./performance.js";
import { positionsPnl } from "./positions-pnl.js";
import { type SankeyData, moneySankey } from "./sankey.js";
import { type ExtendedView, type TodayView, extendedView, todayView } from "./today.js";
import { overviewView } from "./views.js";

export interface TodayPage {
  today: TodayView | null;
  extended: ExtendedView | null;
  /** Since start: dollars made, and against the same money in VTI. */
  sinceStart: RangeFigures | null;
  guardrails: Awaited<ReturnType<typeof overviewView>>["guardrails"];
  lastSync: string | null;
  /** How far the flow-adjusted index is below its peak, % (the halt is at 30). */
  drawdownFromPeakPct: string;
  /** Each conviction holding's headline, by symbol. */
  headlines: Record<string, Headline & { thesisId: string }>;
  /** Null until the position history covers the whole account, or if its inputs don't reconcile. */
  money: SankeyData | null;
}

export async function todayPage(db: Db, env: TradingEnv, now: Date): Promise<TodayPage> {
  const [today, extended, perf, overview, active] = await Promise.all([todayView(db), extendedView(db), performanceView(db), overviewView(db, env, now), activeStrategy(db, now)]);
  const sinceStart = perf.ranges.find((r) => r.range === "all" && r.available) ?? null;
  const headlines = Object.fromEntries(active.strategy.conviction.map((t) => [t.symbol, { ...headlineOf(t), thesisId: t.id }]));

  let money: SankeyData | null = null;
  if (sinceStart?.since && sinceStart.through) {
    const pnl = await positionsPnl(db, sinceStart.since, sinceStart.through);
    const values = await dayValues(db, [sinceStart.since, sinceStart.through]);
    const start = values.find((v) => v.tradingDate === sinceStart.since);
    const end = values.find((v) => v.tradingDate === sinceStart.through);
    if (pnl.status === "ok" && end?.cash != null && start?.afterClosePricing != null) {
      try {
        money = moneySankey({
          // What was there at the start (at the official close) plus what was added since.
          deposited: sub(add(sinceStart.startValue ?? "0", sinceStart.addedSince ?? "0"), start.afterClosePricing),
          parts: [...pnl.positions.map((p) => ({ name: p.symbol, value: p.pnl })), { name: "Dividends, fees and rounding", value: pnl.cashAndOther }],
          holdings: pnl.positions.map((p) => ({ name: p.symbol, value: p.valueEnd })),
          cash: end.cash,
          cap: 8,
        });
      } catch (e) {
        console.error(JSON.stringify({ level: "error", message: "money diagram skipped", error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }
  return { today, extended, sinceStart, guardrails: overview.guardrails, lastSync: overview.lastSync, drawdownFromPeakPct: overview.account.drawdownFromPeakPct, headlines, money };
}

