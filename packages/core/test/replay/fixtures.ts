import type { Bar, CalendarDay } from "../../src/broker/port.js";
import type { SimMarket } from "../../src/replay/sim-broker.js";
import { marketTimeToUtc } from "../../src/time.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

// Synthetic weekday sessions in 2024: far from the real clock (2026), so any
// timestamp taken from the wall clock instead of the replay's stands out.
export function weekdays(from: string, count: number): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); out.length < count; d = new Date(d.getTime() + 86_400_000)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export const HISTORY = 160; // sessions of flat history before the replay starts (eligibility needs 90+ days listed)
export const DAYS = weekdays("2023-09-01", HISTORY + 10);
export const REPLAY = DAYS.slice(HISTORY);
export const day = (n: number) => REPLAY[n - 1]!; // day(1) is the replay's first session

/** Daily bars: flat at `base`, except where `opens` sets a session's open (and close) from then on. */
export function series(base: number, shocks: Record<string, number> = {}): Bar[] {
  let level = base;
  return DAYS.map((date) => {
    if (shocks[date] !== undefined) level = shocks[date]!;
    const p = level.toFixed(2);
    return { t: new Date(`${date}T05:00:00Z`), o: p, h: p, l: p, c: p, v: "1000000" };
  });
}

export function market(shocks: { aapl?: Record<string, number>; vti?: Record<string, number> } = {}): SimMarket {
  // 09:30–16:00 Eastern, so daylight time is right (April is EDT, the replay steps are in ET).
  const calendar: CalendarDay[] = DAYS.map((date) => ({ date, open: marketTimeToUtc(date, "09:30"), close: marketTimeToUtc(date, "16:00") }));
  const asset = (symbol: string) => ({ symbol, name: symbol, status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" });
  return { bars: { AAPL: series(100, shocks.aapl), VTI: series(300, shocks.vti) }, calendar, assets: { AAPL: asset("AAPL"), VTI: asset("VTI") } };
}

export const doc = strategy({
  summary: "Replay test: one AAPL thesis, the rest in VTI.",
  conviction: [thesis({ id: "aapl-replay", symbol: "AAPL", targetWeightPct: "20", stopLossPct: "10" })],
  systematic: { universe: ["VTI"], lookbackDays: 21, skipRecentDays: 0, topN: 1, trendFilterDays: null, weighting: "equal", volatilityDays: 20, defensive: null },
  drift: { relativePct: "20", minTradeUsd: "5" },
});

export const base = (m: SimMarket, autoResume = false) => ({
  market: m,
  versions: [{ at: new Date(`${day(1)}T13:00:00Z`), authoredBy: "claude" as const, document: doc }],
  transfers: [{ at: new Date(`${day(1)}T13:30:00Z`), amount: "10000" }],
  from: day(1),
  to: day(10),
  autoResume,
});

// Each replay builds a fresh database from every migration, then walks its sessions: integration-test sized.
export const REPLAY_TIMEOUT = 60_000;
