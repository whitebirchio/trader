import {
  type DailyBar,
  type EventOutcome as GenericOutcome,
  type OutcomeSkip as GenericSkip,
  type Tradability,
  outcomeAfter,
} from "./backtest.js";

/**
 * The insider-buy backtest (#29, tasks/insider-backtest-plan.md): open-market
 * purchases from SEC's Insider Transactions Data Sets, grouped into events,
 * and each event's return against VTI over the same days.
 *
 * Research only (see backtest.ts). Parsing and grouping take rows, not
 * files, so the EDGAR discovery screen (#15) can reuse them on live filings.
 */

/** One table from a data set: rows keyed by column header. */
export type Rows = Record<string, string>[];

export interface DataSet {
  /** SUBMISSION.tsv */
  submissions: Rows;
  /** REPORTINGOWNER.tsv */
  owners: Rows;
  /** NONDERIV_TRANS.tsv */
  transactions: Rows;
}

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/** "31-OCT-2025" → "2025-10-31"; null if it isn't that shape. */
export function parseSecDate(value: string | undefined): string | null {
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec((value ?? "").trim().toUpperCase());
  const month = m && MONTHS[m[2]!];
  return m && month ? `${m[3]}-${month}-${m[1]}` : null;
}

/** Parse a tab-separated table (header row first). SEC's files don't quote fields. */
export function parseTsv(text: string): Rows {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = (lines.shift() ?? "").split("\t");
  return lines.map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/** One filing's open-market purchases: one buyer (a joint filing counts once). */
export interface InsiderPurchase {
  accession: string;
  issuerCik: string;
  ticker: string;
  /** YYYY-MM-DD: when the buy became public. */
  filedOn: string;
  /** The earliest trade date in the filing. */
  tradedOn: string;
  /** The first reporting owner's CIK; a joint filing (a fund and its parent) is one buyer. */
  buyer: string;
  buyerName: string;
  director: boolean;
  officer: boolean;
  tenPercentOwner: boolean;
  ceoOrCfo: boolean;
  /** Σ shares × price of the filing's purchases. */
  dollars: number;
  /** A routine buyer's purchase (see classifyRoutine); null until classified, or without the history. */
  routine: boolean | null;
}

const CEO_OR_CFO = /\b(ceo|cfo|chief executive|chief financial)\b/i;

const flag = (v: string | undefined): boolean | null => {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  return null;
};

/**
 * Open-market purchases (code P, acquired, price > 0) on original Form 4s
 * (not amendments) by a director, officer or 10% owner, leaving out filings
 * flagged as 10b5-1 plan trades (the flag exists from 2023; blank is unknown
 * and kept). One purchase per filing.
 */
export function purchasesFrom(data: DataSet): InsiderPurchase[] {
  const subs = new Map(data.submissions.map((s) => [s.ACCESSION_NUMBER!, s]));
  const owners = new Map<string, Rows>();
  for (const o of data.owners) {
    const list = owners.get(o.ACCESSION_NUMBER!) ?? [];
    list.push(o);
    owners.set(o.ACCESSION_NUMBER!, list);
  }

  const byFiling = new Map<string, { dollars: number; tradedOn: string }>();
  for (const t of data.transactions) {
    if (t.TRANS_CODE !== "P" || t.TRANS_ACQUIRED_DISP_CD !== "A") continue;
    const shares = Number(t.TRANS_SHARES);
    const price = Number(t.TRANS_PRICEPERSHARE);
    const tradedOn = parseSecDate(t.TRANS_DATE);
    if (!(shares > 0) || !(price > 0) || !tradedOn) continue;
    const f = byFiling.get(t.ACCESSION_NUMBER!) ?? { dollars: 0, tradedOn };
    f.dollars += shares * price;
    if (tradedOn < f.tradedOn) f.tradedOn = tradedOn;
    byFiling.set(t.ACCESSION_NUMBER!, f);
  }

  const out: InsiderPurchase[] = [];
  for (const [accession, f] of byFiling) {
    const s = subs.get(accession);
    const filedOn = parseSecDate(s?.FILING_DATE);
    const ticker = (s?.ISSUERTRADINGSYMBOL ?? "").trim().toUpperCase();
    const people = owners.get(accession) ?? [];
    if (!s || s.DOCUMENT_TYPE !== "4" || !filedOn || !ticker || people.length === 0) continue;
    if (flag(s.AFF10B5ONE) === true) continue;
    const roles = people.flatMap((p) => (p.RPTOWNER_RELATIONSHIP ?? "").split(","));
    const director = roles.includes("Director");
    const officer = roles.includes("Officer");
    const tenPercentOwner = roles.includes("TenPercentOwner");
    if (!director && !officer && !tenPercentOwner) continue;
    out.push({
      accession,
      issuerCik: s.ISSUERCIK!,
      ticker,
      filedOn,
      tradedOn: f.tradedOn,
      buyer: people[0]!.RPTOWNERCIK!,
      buyerName: people[0]!.RPTOWNERNAME ?? "",
      director,
      officer,
      tenPercentOwner,
      ceoOrCfo: people.some((p) => CEO_OR_CFO.test(p.RPTOWNER_TITLE ?? "")),
      dollars: f.dollars,
      routine: null,
    });
  }
  return out;
}

/**
 * Routine buyers (Cohen, Malloy & Pomorski, "Decoding Inside Information",
 * 2012): one who bought the same issuer in the same calendar month in each
 * of the two prior years, such as directors buying on a fixed schedule.
 * Their buys carry little information; the others are opportunistic. Null
 * when the data doesn't reach two years back (`historyFrom` is its first
 * filing date).
 */
export function classifyRoutine(purchases: InsiderPurchase[], historyFrom: string): InsiderPurchase[] {
  const months = new Set(purchases.map((p) => `${p.issuerCik}|${p.buyer}|${p.filedOn.slice(0, 7)}`));
  const covered = (year: number, month: string) => `${year}-${month}-01` >= historyFrom.slice(0, 7) + "-01";
  return purchases.map((p) => {
    const year = Number(p.filedOn.slice(0, 4));
    const month = p.filedOn.slice(5, 7);
    if (!covered(year - 2, month)) return { ...p, routine: null };
    const boughtIn = (y: number) => months.has(`${p.issuerCik}|${p.buyer}|${y}-${month}`);
    return { ...p, routine: boughtIn(year - 1) && boughtIn(year - 2) };
  });
}

/** Buys in one issuer filed within `windowDays` of the event's first filing. */
export interface InsiderEvent {
  issuerCik: string;
  ticker: string;
  firstFiled: string;
  /** Entry is the first close after this. */
  lastFiled: string;
  /** Distinct buyers. */
  buyers: number;
  ceoOrCfo: boolean;
  /** An officer or director bought (not only 10% owners). */
  insider: boolean;
  /** Any buy was opportunistic (not routine); false if all were routine; null if unclassified. */
  opportunistic: boolean | null;
  dollars: number;
  purchases: InsiderPurchase[];
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS;

/** Group purchases per issuer into events: a window opens at a filing and takes every filing within `windowDays` of it. */
export function groupEvents(purchases: InsiderPurchase[], windowDays = 30): InsiderEvent[] {
  const byIssuer = new Map<string, InsiderPurchase[]>();
  for (const p of purchases) {
    const list = byIssuer.get(p.issuerCik) ?? [];
    list.push(p);
    byIssuer.set(p.issuerCik, list);
  }
  const events: InsiderEvent[] = [];
  for (const list of byIssuer.values()) {
    list.sort((a, b) => a.filedOn.localeCompare(b.filedOn) || a.accession.localeCompare(b.accession));
    let current: InsiderPurchase[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const last = current.at(-1)!;
      events.push({
        issuerCik: last.issuerCik,
        ticker: last.ticker,
        firstFiled: current[0]!.filedOn,
        lastFiled: last.filedOn,
        buyers: new Set(current.map((p) => p.buyer)).size,
        ceoOrCfo: current.some((p) => p.ceoOrCfo),
        insider: current.some((p) => p.director || p.officer),
        opportunistic: current.some((p) => p.routine === false) ? true : current.every((p) => p.routine === true) ? false : null,
        dollars: current.reduce((sum, p) => sum + p.dollars, 0),
        purchases: current,
      });
      current = [];
    };
    for (const p of list) {
      if (current.length > 0 && daysBetween(current[0]!.filedOn, p.filedOn) > windowDays) flush();
      current.push(p);
    }
    flush();
  }
  return events.sort((a, b) => a.lastFiled.localeCompare(b.lastFiled) || a.ticker.localeCompare(b.ticker));
}

export type { BucketStats, DailyBar, Horizon, Tradability } from "./backtest.js";
export { HORIZONS, breakdown, bucketStats } from "./backtest.js";

export type EventOutcome = GenericOutcome<InsiderEvent>;
export type OutcomeSkip = GenericSkip<InsiderEvent>;

/** Enter at the first close after the last filing, when the buy became public (see outcomeAfter). */
export function eventOutcome(event: InsiderEvent, bars: DailyBar[], vti: DailyBar[], t: Tradability): EventOutcome | OutcomeSkip {
  return outcomeAfter(event, event.lastFiled, bars, vti, t);
}

/** A prior drawdown of this much or worse makes an event a "dip" buy. */
export const DIP = -0.2;

/** The buckets the report breaks results into, each a label for an outcome (null: not in this breakdown). */
export const BREAKDOWNS: Record<string, (o: EventOutcome) => string | null> = {
  "Distinct buyers": (o) => (o.event.buyers >= 3 ? "3+" : String(o.event.buyers)),
  "Who bought": (o) => (o.event.ceoOrCfo ? "CEO or CFO" : o.event.insider ? "Other officers/directors" : "10% owners only"),
  "Dollars bought": (o) => (o.event.dollars >= 1_000_000 ? "$1M+" : o.event.dollars >= 100_000 ? "$100k–$1M" : "Under $100k"),
  "Prior 60 trading days": (o) => (o.prior60 === null ? null : o.prior60 <= DIP ? "Down 20%+ (dip)" : "Not a dip"),
  "Like the live strategy": (o) =>
    o.event.insider && o.event.buyers >= 2 && o.prior60 !== null && o.prior60 <= DIP ? "2+ insiders after a 20%+ drop" : "Everything else",
  "Routine or opportunistic (from 2020)": (o) => (o.event.opportunistic === null ? null : o.event.opportunistic ? "Opportunistic" : "Routine"),
  "Like the live strategy, opportunistic only (from 2020)": (o) =>
    o.event.opportunistic === null
      ? null
      : o.event.opportunistic && o.event.insider && o.event.buyers >= 2 && o.prior60 !== null && o.prior60 <= DIP
        ? "2+ insiders after a 20%+ drop, opportunistic"
        : "Everything else",
  "Year of entry": (o) => o.entryDate.slice(0, 4),
};
