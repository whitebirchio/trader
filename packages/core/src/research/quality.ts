import type { DailyBar } from "./backtest.js";

/**
 * The quality/value backtest (#49, tasks/momentum-quality-plan.md): yearly
 * fundamentals from SEC's XBRL frames, scored at the end of each April, with
 * the momentum module's deciles and series statistics. Pure.
 *
 * Frames have no filing date, so a figure counts for a formation only if its
 * period ended at least LAG_DAYS before it (10-Ks are due 60–90 days after
 * year-end). Frames take each figure from the latest filing that reports it,
 * which is usually a later 10-K's comparative column with the same value; a
 * genuine restatement can leak a revised figure. Filtering by the
 * accession's filing year was tried and dropped: it removed 75–86% of real
 * figures (the comparatives), not just restatements.
 */

export interface FrameRow {
  cik: number;
  accn: string;
  start?: string;
  end: string;
  val: number;
}

/** The rows of one frames JSON document. */
export function frameRows(doc: unknown): FrameRow[] {
  const data = (doc as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (r): r is FrameRow =>
      typeof r === "object" && r !== null && typeof (r as FrameRow).cik === "number" && typeof (r as FrameRow).accn === "string" && typeof (r as FrameRow).end === "string" && typeof (r as FrameRow).val === "number",
  );
}

export const LAG_DAYS = 75;
const DAY_MS = 86_400_000;

/** Whether a row's period ended early enough to have been reported by `formation` (YYYY-MM-DD). */
export function knownBy(row: FrameRow, formation: string): boolean {
  return Date.parse(`${row.end}T00:00:00Z`) + LAG_DAYS * DAY_MS <= Date.parse(`${formation}T00:00:00Z`);
}

/** The frames for one data year, by concept; alternatives are tried in order. */
export interface YearFrames {
  grossProfit: FrameRow[];
  revenues: FrameRow[][];
  costOfRevenue: FrameRow[][];
  netIncome: FrameRow[];
  assets: FrameRow[];
  equity: FrameRow[];
  shares: FrameRow[][];
}

export interface Fundamentals {
  cik: number;
  grossProfit: number | null;
  netIncome: number | null;
  assets: number | null;
  equity: number | null;
  shares: number | null;
}

/** Each company's fundamentals known at `formation`. Gross profit falls back to revenue minus cost of revenue. */
export function fundamentalsAt(frames: YearFrames, formation: string): Map<number, Fundamentals> {
  const index = (rows: FrameRow[]) => new Map(rows.filter((r) => knownBy(r, formation)).map((r) => [r.cik, r.val]));
  const first = (alternatives: FrameRow[][]) => {
    const maps = alternatives.map(index);
    return (cik: number) => maps.map((m) => m.get(cik)).find((v) => v !== undefined);
  };
  const gp = index(frames.grossProfit);
  const revenue = first(frames.revenues);
  const cost = first(frames.costOfRevenue);
  const ni = index(frames.netIncome);
  const assets = index(frames.assets);
  const equity = index(frames.equity);
  const shares = first(frames.shares);

  const ciks = new Set([...gp.keys(), ...ni.keys(), ...assets.keys()]);
  const out = new Map<number, Fundamentals>();
  for (const cik of ciks) {
    const r = revenue(cik);
    const c = cost(cik);
    out.set(cik, {
      cik,
      grossProfit: gp.get(cik) ?? (r !== undefined && c !== undefined ? r - c : null),
      netIncome: ni.get(cik) ?? null,
      assets: assets.get(cik) ?? null,
      equity: equity.get(cik) ?? null,
      shares: shares(cik) ?? null,
    });
  }
  return out;
}

export interface QualityMetrics {
  /** Gross profit ÷ total assets (Novy-Marx). */
  grossProfitability: number | null;
  /** Net income ÷ market value. */
  earningsYield: number | null;
  /** Stockholders' equity ÷ market value. */
  bookToMarket: number | null;
}

/** The metrics from fundamentals and an unadjusted price at formation; null where an input is missing or not positive. */
export function qualityMetrics(f: Fundamentals, price: number | null): QualityMetrics {
  const value = f.shares !== null && price !== null && f.shares > 0 && price > 0 ? f.shares * price : null;
  return {
    grossProfitability: f.grossProfit !== null && f.assets !== null && f.assets > 0 ? f.grossProfit / f.assets : null,
    earningsYield: f.netIncome !== null && value !== null ? f.netIncome / value : null,
    bookToMarket: f.equity !== null && value !== null ? f.equity / value : null,
  };
}

/** Percentile rank (0–1) of each value among `values` (ties share the lower rank). */
export function percentileRanks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  return values.map((v) => (n <= 1 ? 0.5 : sorted.indexOf(v) / (n - 1)));
}

/** The last session of April in `year`, from ascending session dates. */
export function aprilFormation(sessions: string[], year: number): string | null {
  const april = sessions.filter((d) => d.startsWith(`${year}-04-`));
  return april.at(-1) ?? null;
}

/** The unadjusted close on or before `date` within the week before it, or null. */
export function rawCloseNear(bars: DailyBar[], date: string): number | null {
  const floor = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    if (b.date <= date) return b.date >= floor ? b.close : null;
  }
  return null;
}
