import { type Rows, parseSecDate } from "./insider-backtest.js";

/**
 * The 13F backtest (#138, tasks/13f-backtest-plan.md): holdings from SEC's
 * Form 13F Data Sets, a point-in-time set of concentrated long-horizon
 * managers, and the events their filings show (new positions, large adds,
 * best ideas, names several of them bought at once).
 *
 * Research only (see backtest.ts). INFOTABLE runs to millions of rows a
 * window, so filings are built row by row (filingBuilder) from a stream the
 * script reads off disk; nothing here holds a whole table.
 */

/** A filing's header: one row each of SUBMISSION, COVERPAGE and SUMMARYPAGE. */
export interface FilingMeta {
  accession: string;
  /** Ten digits, as SEC writes it. */
  cik: string;
  manager: string;
  /** The quarter-end the holdings are as of (YYYY-MM-DD). */
  period: string;
  /** When it became public (YYYY-MM-DD). */
  filedOn: string;
  /** SUMMARYPAGE's row count (before options, notes and sub-manager splits are dropped). */
  entries: number;
}

export interface WindowMeta {
  /** Original 13F-HR holdings reports, filed within MAX_FILING_LAG_DAYS of their period. */
  originals: FilingMeta[];
  /** 13F-HR/A: counted, not scored (a late confidential-treatment disclosure among them). */
  amendments: number;
  /** Originals filed more than MAX_FILING_LAG_DAYS after their period: stale, not scored. */
  late: number;
  /** Every CIK that filed an original 13F-HR (Part 2 keeps 13D/13G filers among them). */
  filers: string[];
}

/** The deadline is 45 days; a filing much later than this reports old news. */
export const MAX_FILING_LAG_DAYS = 120;

const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/** The scoreable filings in one window's SUBMISSION, COVERPAGE and SUMMARYPAGE tables. */
export function windowMeta(tables: { submissions: Rows; covers: Rows; summaries: Rows }): WindowMeta {
  const cover = new Map(tables.covers.map((r) => [r.ACCESSION_NUMBER!, r]));
  const summary = new Map(tables.summaries.map((r) => [r.ACCESSION_NUMBER!, r]));
  const originals: FilingMeta[] = [];
  const filers = new Set<string>();
  let amendments = 0;
  let late = 0;
  const seen = new Set<string>();
  // Earliest-filed first, so a refiled original for the same period loses to the one that was public first.
  const rows = [...tables.submissions].sort((a, b) => (parseSecDate(a.FILING_DATE) ?? "").localeCompare(parseSecDate(b.FILING_DATE) ?? ""));
  for (const r of rows) {
    const type = (r.SUBMISSIONTYPE ?? "").trim();
    if (type === "13F-HR/A") amendments++;
    if (type !== "13F-HR") continue;
    const c = cover.get(r.ACCESSION_NUMBER!);
    const filedOn = parseSecDate(r.FILING_DATE);
    const period = parseSecDate(r.PERIODOFREPORT);
    if (!c || !filedOn || !period || /NOTICE/i.test(c.REPORTTYPE ?? "")) continue;
    filers.add(r.CIK!);
    const key = `${r.CIK}#${period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (days(period, filedOn) > MAX_FILING_LAG_DAYS) {
      late++;
      continue;
    }
    originals.push({
      accession: r.ACCESSION_NUMBER!,
      cik: r.CIK!,
      manager: (c.FILINGMANAGER_NAME ?? "").trim(),
      period,
      filedOn,
      entries: Number(summary.get(r.ACCESSION_NUMBER!)?.TABLEENTRYTOTAL ?? Number.NaN),
    });
  }
  return { originals, amendments, late, filers: [...filers].sort() };
}

/** One security in a filing, summed over its rows (sub-managers, discretion types). */
export interface Position {
  cusip: string;
  issuer: string;
  /** Dollars (see toDollars). */
  value: number;
  shares: number;
}

export interface Filing extends Omit<FilingMeta, "entries"> {
  /** Largest first. */
  positions: Position[];
  /** Set when the filing's units disagreed with its filing date (see toDollars). */
  unitsCorrected?: true;
}

/**
 * Values are in thousands of dollars on filings before this date and in
 * dollars from it (SEC's 2022 amendments to Form 13F).
 */
export const DOLLAR_VALUES_FROM = "2023-01-03";

/**
 * Convert a filing's values to dollars. Some filers used the wrong unit for
 * the era, which shows as a median implied share price 1000× off: above
 * $5,000 (dollars reported as thousands) or under $0.50 (thousands reported
 * as dollars).
 */
export function toDollars(positions: Position[], filedOn: string): { positions: Position[]; corrected: boolean } {
  let factor = filedOn < DOLLAR_VALUES_FROM ? 1000 : 1;
  const prices = positions.filter((p) => p.shares > 0).map((p) => (p.value * factor) / p.shares).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)]! : null;
  let corrected = false;
  if (median !== null && median > 5000) {
    factor /= 1000;
    corrected = true;
  } else if (median !== null && median < 0.5) {
    factor *= 1000;
    corrected = true;
  }
  return { positions: positions.map((p) => ({ ...p, value: p.value * factor })), corrected };
}

/**
 * Build filings from INFOTABLE rows, one row at a time. Only accessions in
 * `keep` are accumulated. Option rows (PUTCALL) and principal-amount rows
 * (notes, SSHPRNAMTTYPE = PRN) are dropped; rows for the same CUSIP are summed.
 */
export function filingBuilder(keep: Map<string, FilingMeta>) {
  const held = new Map<string, Map<string, Position>>();
  return {
    add(row: Record<string, string>): void {
      const accession = row.ACCESSION_NUMBER ?? "";
      if (!keep.has(accession)) return;
      if ((row.PUTCALL ?? "").trim() !== "" || (row.SSHPRNAMTTYPE ?? "").trim().toUpperCase() !== "SH") return;
      const cusip = (row.CUSIP ?? "").trim().toUpperCase();
      const value = Number(row.VALUE);
      const shares = Number(row.SSHPRNAMT);
      if (cusip.length !== 9 || !(value > 0) || !(shares > 0)) return;
      const positions = held.get(accession) ?? new Map<string, Position>();
      held.set(accession, positions);
      const p = positions.get(cusip);
      if (p) {
        p.value += value;
        p.shares += shares;
      } else positions.set(cusip, { cusip, issuer: (row.NAMEOFISSUER ?? "").trim(), value, shares });
    },
    filings(): Filing[] {
      const out: Filing[] = [];
      for (const [accession, meta] of keep) {
        const { entries: _, ...header } = meta;
        const { positions, corrected } = toDollars([...(held.get(accession)?.values() ?? [])], meta.filedOn);
        positions.sort((a, b) => b.value - a.value || a.cusip.localeCompare(b.cusip));
        out.push({ ...header, positions, ...(corrected ? { unitsCorrected: true as const } : {}) });
      }
      return out;
    },
  };
}

/** "2025-06-30" → "2025Q2". */
export function quarterOf(date: string): string {
  return `${date.slice(0, 4)}Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

/** "2025Q1" → "2024Q4". */
export function previousQuarter(q: string): string {
  const y = Number(q.slice(0, 4));
  const n = Number(q.slice(5));
  return n === 1 ? `${y - 1}Q4` : `${y}Q${n - 1}`;
}

/** The concentrated-manager rule, fixed before any results (#138). */
export const MANAGER_RULE = {
  maxPositions: 30,
  minValue: 1e9,
  minPriorFilings: 4,
  /** The median current position has appeared in at least this many consecutive prior filings… */
  minMedianHeld: 4,
  /** …counting back at most this many. */
  heldCap: 8,
  /** Two filings in one period this alike by value are one group filing under several CIKs. */
  relatedOverlap: 0.9,
} as const;

/** Shown beside the rule-based set, never promoted: we know these names because they did well. */
export const NAMED_MANAGERS: Record<string, string> = {
  "0001067983": "Berkshire Hathaway",
  "0001336528": "Pershing Square",
  "0002026053": "Pershing Square",
};

/**
 * How many consecutive prior quarters (most recent first, from the quarter
 * before `quarter`) a CUSIP was held in, capped. A missing filing ends the run.
 */
export function quartersHeld(cusip: string, quarter: string, prior: Map<string, Filing>, cap: number): number {
  let n = 0;
  for (let q = previousQuarter(quarter); n < cap; q = previousQuarter(q)) {
    const f = prior.get(q);
    if (!f || !f.positions.some((p) => p.cusip === cusip)) break;
    n++;
  }
  return n;
}

/** The manager's earlier filings by quarter, from a history that may hold later ones too (they're ignored). */
function priorByQuarter(quarter: string, history: Filing[]): Map<string, Filing> {
  return new Map(history.filter((f) => quarterOf(f.period) < quarter).map((f) => [quarterOf(f.period), f]));
}

/** Whether a filing's manager passes MANAGER_RULE, judged only on filings up to it. */
export function qualifies(filing: Filing, history: Filing[]): boolean {
  const r = MANAGER_RULE;
  const total = filing.positions.reduce((s, p) => s + p.value, 0);
  if (filing.positions.length === 0 || filing.positions.length > r.maxPositions || total < r.minValue) return false;
  const quarter = quarterOf(filing.period);
  const prior = priorByQuarter(quarter, history);
  if (prior.size < r.minPriorFilings) return false;
  const held = filing.positions.map((p) => quartersHeld(p.cusip, quarter, prior, r.heldCap)).sort((a, b) => a - b);
  const mid = Math.floor(held.length / 2);
  const median = held.length % 2 ? held[mid]! : (held[mid - 1]! + held[mid]!) / 2;
  return median >= r.minMedianHeld;
}

/** Σ min(weight) over shared CUSIPs: 1 for identical books, 0 for disjoint ones. */
export function overlap(a: Filing, b: Filing): number {
  const weights = (f: Filing) => {
    const total = f.positions.reduce((s, p) => s + p.value, 0);
    return new Map(f.positions.map((p) => [p.cusip, total > 0 ? p.value / total : 0]));
  };
  const wa = weights(a);
  const wb = weights(b);
  let sum = 0;
  for (const [cusip, w] of wa) sum += Math.min(w, wb.get(cusip) ?? 0);
  return sum;
}

/** Collapse one group's filings under several CIKs to the largest. */
export function collapseRelated(filings: Filing[]): Filing[] {
  const value = (f: Filing) => f.positions.reduce((s, p) => s + p.value, 0);
  const kept: Filing[] = [];
  for (const f of [...filings].sort((a, b) => value(b) - value(a) || a.cik.localeCompare(b.cik))) {
    if (!kept.some((k) => overlap(k, f) >= MANAGER_RULE.relatedOverlap)) kept.push(f);
  }
  return kept;
}

/**
 * A period's concentrated managers: filings that pass MANAGER_RULE, judged on
 * each manager's own earlier filings (`history` by CIK), related filers collapsed.
 */
export function managerSet(filings: Filing[], history: Map<string, Filing[]>): Filing[] {
  return collapseRelated(filings.filter((f) => qualifies(f, history.get(f.cik) ?? [])));
}

/**
 * A period's named-list filings: one per name, the largest by value (Pershing
 * files under more than one CIK, and the smaller filing can be one holding).
 */
export function namedSet(filings: Filing[]): Filing[] {
  const value = (f: Filing) => f.positions.reduce((s, p) => s + p.value, 0);
  const best = new Map<string, Filing>();
  for (const f of filings) {
    const name = NAMED_MANAGERS[f.cik];
    if (!name) continue;
    const had = best.get(name);
    if (!had || value(f) > value(had)) best.set(name, f);
  }
  return [...best.values()].sort((a, b) => a.cik.localeCompare(b.cik));
}

export type EventKind = "new" | "add" | "best" | "top3" | "newTop5" | "consensus";

export interface ThirteenFEvent {
  kind: EventKind;
  /** The manager (for consensus, the one whose filing completed it). */
  cik: string;
  manager: string;
  /** The quarter-end the holdings are as of. */
  period: string;
  /** When the event became public: entry is the first close after it. */
  filedOn: string;
  cusip: string;
  issuer: string;
  /** Share of the manager's reported book by value (for consensus, the number of managers). */
  weight: number;
}

/** Shares up this much, after splits, is a large add. */
export const LARGE_ADD = 1.25;

/**
 * A new top-5 position must also be at least this share of the book: in a
 * book of three or four names, any new one is "top 5" (Scott, 2026-11-20,
 * at Checkpoint A, before the full run was scored).
 */
export const NEW_TOP5_MIN_WEIGHT = 0.05;

/**
 * One manager's events in a filing. `previous` is their filing for the
 * quarter before (without it only best/top3 are known). `heldBefore` is every
 * CUSIP any filer held the quarter before: a new position must be in one of
 * them, so an IPO's or a changed CUSIP's first filing isn't read as everyone
 * buying. `shareRatio` is the median ratio of
 * shares now to shares before across all filers holding the CUSIP both
 * quarters, so a stock split isn't read as everyone adding.
 */
export function positionEvents(current: Filing, previous: Filing | undefined, heldBefore: Set<string>, shareRatio: Map<string, number>): ThirteenFEvent[] {
  const total = current.positions.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return [];
  const before = previous && quarterOf(previous.period) === previousQuarter(quarterOf(current.period)) ? new Map(previous.positions.map((p) => [p.cusip, p])) : null;
  const events: ThirteenFEvent[] = [];
  current.positions.forEach((p, rank) => {
    const event = (kind: EventKind): ThirteenFEvent => ({ kind, cik: current.cik, manager: current.manager, period: current.period, filedOn: current.filedOn, cusip: p.cusip, issuer: p.issuer, weight: p.value / total });
    if (rank === 0) events.push(event("best"));
    if (rank < 3) events.push(event("top3"));
    if (!before) return;
    const was = before.get(p.cusip);
    if (!was && heldBefore.has(p.cusip)) {
      events.push(event("new"));
      if (rank < 5 && p.value / total >= NEW_TOP5_MIN_WEIGHT) events.push(event("newTop5"));
    } else if (was && p.shares / was.shares / (shareRatio.get(p.cusip) ?? 1) >= LARGE_ADD) events.push(event("add"));
  });
  return events;
}

/**
 * Names newly bought or added by 2+ managers in one period: one event per
 * name, public when the second manager's filing was.
 */
export function consensusEvents(events: ThirteenFEvent[]): ThirteenFEvent[] {
  const byName = new Map<string, ThirteenFEvent[]>();
  for (const e of events) {
    if (e.kind !== "new" && e.kind !== "add") continue;
    const key = `${quarterOf(e.period)}#${e.cusip}`;
    byName.set(key, [...(byName.get(key) ?? []), e]);
  }
  const out: ThirteenFEvent[] = [];
  for (const list of byName.values()) {
    const first = new Map<string, ThirteenFEvent>();
    for (const e of [...list].sort((a, b) => a.filedOn.localeCompare(b.filedOn) || a.cik.localeCompare(b.cik))) if (!first.has(e.cik)) first.set(e.cik, e);
    const managers = [...first.values()];
    if (managers.length < 2) continue;
    const second = managers[1]!;
    out.push({ ...second, kind: "consensus", weight: managers.length });
  }
  return out.sort((a, b) => a.filedOn.localeCompare(b.filedOn) || a.cusip.localeCompare(b.cusip));
}

/** For each CUSIP held by at least `minHolders` filers in both quarters, the median of shares now over shares before. */
export function shareRatios(current: Filing[], previous: Filing[], minHolders = 5): Map<string, number> {
  const before = new Map(previous.map((f) => [f.cik, new Map(f.positions.map((p) => [p.cusip, p.shares]))]));
  const ratios = new Map<string, number[]>();
  for (const f of current) {
    const was = before.get(f.cik);
    if (!was) continue;
    for (const p of f.positions) {
      const s = was.get(p.cusip);
      if (s) ratios.set(p.cusip, [...(ratios.get(p.cusip) ?? []), p.shares / s]);
    }
  }
  const out = new Map<string, number>();
  for (const [cusip, xs] of ratios) {
    if (xs.length < minHolders) continue;
    xs.sort((a, b) => a - b);
    out.set(cusip, xs[Math.floor(xs.length / 2)]!);
  }
  return out;
}

/** What OpenFIGI's mapping API says a CUSIP is: a US ticker and whether it's a stock Trader could hold. */
export interface Figi {
  ticker: string | null;
  /** ETFs, funds and anything that isn't an equity share. */
  excluded: boolean;
  name: string | null;
}

const EXCLUDED_TYPES = /\b(ETP|ETF|Mutual Fund|Closed-End Fund|Unit|Right|Warrant)\b/i;

/**
 * One job's result from POST /v3/mapping ([{ data: [...] }] or [{ warning }]),
 * requested without an exchange filter: asking for exchCode "US" misses
 * listings whose composite row isn't returned (Exxon's CUSIP, for one). Takes
 * the US composite row, else the ticker most US exchange rows (codes "U?")
 * carry; a CUSIP with no US listing is unmapped. OpenFIGI writes share classes
 * with a slash (BRK/B), Alpaca with a dot (BRK.B).
 */
export function parseFigi(result: { data?: Record<string, string | null>[]; warning?: string; error?: string }): Figi {
  const rows = result.data ?? [];
  const us = rows.filter((r) => /^U[A-Z]$/.test(r.exchCode ?? "") && r.ticker);
  const counts = new Map<string, number>();
  for (const r of us) counts.set(r.ticker!, (counts.get(r.ticker!) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const row = rows.find((r) => r.exchCode === "US" && r.ticker) ?? us.find((r) => r.ticker === common);
  if (!row) return { ticker: null, excluded: false, name: null };
  const type = `${row.securityType ?? ""} ${row.securityType2 ?? ""}`;
  return {
    ticker: row.ticker ? row.ticker.replace("/", ".") : null,
    excluded: row.marketSector !== "Equity" || EXCLUDED_TYPES.test(type),
    name: row.name ?? null,
  };
}

/** A data-set window's name ("2016q1", "01jun2025-31aug2025") → its first day, for ordering; null if unrecognised. */
export function windowStart(name: string): string | null {
  const q = /^(\d{4})q([1-4])$/.exec(name);
  if (q) return `${q[1]}-${String(Number(q[2]) * 3 - 2).padStart(2, "0")}-01`;
  const d = /^(\d{2})([a-z]{3})(\d{4})-/.exec(name);
  return d ? parseSecDate(`${d[1]}-${d[2]}-${d[3]}`) : null;
}

/** The data-set zips linked from SEC's Form 13F Data Sets page, oldest first. */
export function windowLinks(html: string): { name: string; path: string; start: string }[] {
  const out = new Map<string, { name: string; path: string; start: string }>();
  for (const m of html.matchAll(/href="(\/files\/[^"]*\/([0-9a-z-]+)_form13f\.zip)"/g)) {
    const start = windowStart(m[2]!);
    if (start) out.set(m[2]!, { name: m[2]!, path: m[1]!, start });
  }
  return [...out.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/** A security's most recent symbol in SEC's fails-to-deliver data. */
export interface FtdSymbol {
  symbol: string;
  /** YYYY-MM-DD */
  date: string;
  description: string;
}

/** One row of SEC's fails-to-deliver data (SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE); null for the header or a bad row. */
export function ftdRow(line: string): ({ cusip: string } & FtdSymbol) | null {
  const [date, cusip, symbol, , description] = line.split("|");
  if (!date || !/^\d{8}$/.test(date) || !cusip || cusip.trim().length !== 9 || !symbol?.trim()) return null;
  return { cusip: cusip.trim().toUpperCase(), symbol: symbol.trim().toUpperCase(), date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, description: (description ?? "").trim() };
}

/** Keep each CUSIP's latest symbol. */
export function noteSymbol(latest: Map<string, FtdSymbol>, row: { cusip: string } & FtdSymbol): void {
  const had = latest.get(row.cusip);
  if (!had || row.date >= had.date) latest.set(row.cusip, { symbol: row.symbol, date: row.date, description: row.description });
}

export const FUND_NAME = /\b(ETF|ETN|FUND|FD|ISHARES|SPDR|PROSHARES)\b/i;

/**
 * The ticker to fetch bars for: OpenFIGI's US listing when it has one (it
 * writes share classes as Alpaca does), else the CUSIP's latest symbol in
 * SEC's fails-to-deliver data. OpenFIGI often returns only a CUSIP's foreign
 * listings, so the fallback matters. A fails-data symbol that isn't plain
 * letters is left unmapped, and so is a share class (BRKB can't be told from
 * a ticker named BRKB).
 */
export function resolveTicker(figi: Figi | undefined, ftd: FtdSymbol | undefined): { ticker: string | null; excluded: boolean; source: "openfigi" | "fails data" | null } {
  if (figi?.ticker) return { ticker: figi.ticker, excluded: figi.excluded, source: "openfigi" };
  if (!ftd || !/^[A-Z]{1,5}$/.test(ftd.symbol) || /\bCL(ASS)?\s+[A-Z]\b/i.test(ftd.description)) return { ticker: null, excluded: false, source: null };
  return { ticker: ftd.symbol, excluded: (figi?.excluded ?? false) || FUND_NAME.test(ftd.description), source: "fails data" };
}

/** The fails-to-deliver zips linked from SEC's page ("cnsfails201806a"), oldest first. */
export function ftdLinks(html: string): { name: string; path: string }[] {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/href="(\/files\/[^"]*\/(cnsfails\d{6}[ab])\.zip)"/g)) out.set(m[2]!, m[1]!);
  return [...out].map(([name, path]) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name));
}
