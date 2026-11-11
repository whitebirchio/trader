import { and, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { Db } from "../db/client.js";
import { jobRuns, secFilings } from "../db/schema.js";
import { add, compare, mul, round } from "../money.js";
import { activeStrategy } from "../portfolio/store.js";
import { marketDate } from "../time.js";
import type { FilingsFeedPort, IndexedFiling } from "./sec.js";
import { readWatchlist } from "./watchlist.js";

/**
 * SEC filings on every held and watched name (#105), checked hourly by the
 * check-filings job. The routine's runs found filings by web search, which
 * covered only the names that moved and missed an 8-K and three insider
 * filings for two days (2026-11-09 to 11-11). EDGAR is free and primary, so
 * code now reads it for every name, and get_holdings and get_watchlist show
 * what's new. Two kinds of filing on a held name are sell signals (the
 * routine's list) and email the owner at once: an officer or director
 * leaving, and an officer or director selling on the open market outside a
 * 10b5-1 plan. Informational: code doesn't sell on them.
 */

export const FILINGS_LIMITS = {
  /** How far back a name's index is read: a newly watched name starts with this much. */
  lookbackDays: 30,
  /** Only filings this recent alert or reach the digest, so a new name's backlog doesn't. */
  alertWithinDays: 3,
  /** Rows older than this are pruned. */
  keepDays: 180,
  /** get_holdings calls the check stale after this long. */
  staleAfterHours: 3,
  /** Filings listed per name in the tools, newest first. */
  perName: 10,
  /** Stop starting new names after this long, well inside the Lambda's 5 minutes. */
  budgetMs: 120_000,
} as const;

export type FilingKind = "insider_sale" | "insider_buy" | "insider_other" | "sale_notice" | "officer_change" | "results" | "other_8k" | "large_holder" | "periodic";
export type SellSignal = "insider_sale" | "executive_departure";

/** The forms worth reading: insider trades and sale notices, 8-Ks, 5% holders, and the periodic reports. */
const TRACKED = /^(4|4\/A|144|144\/A|8-K|8-K\/A|10-Q|10-K|SC 13[DG](\/A)?|SCHEDULE 13[DG](\/A)?)$/;

/** 8-K items in plain words; 9.01 (exhibits) is left out. */
const ITEMS: Record<string, string> = {
  "1.01": "entered a material agreement",
  "1.02": "ended a material agreement",
  "1.03": "bankruptcy or receivership",
  "1.05": "a cybersecurity incident",
  "2.01": "completed an acquisition or sale of assets",
  "2.02": "results of operations",
  "2.03": "took on a material debt",
  "2.04": "a debt was accelerated",
  "2.05": "exit or restructuring costs",
  "2.06": "a material impairment",
  "3.01": "a delisting notice",
  "3.02": "sold unregistered shares",
  "3.03": "changed shareholders' rights",
  "4.01": "changed auditors",
  "4.02": "past financial statements can no longer be relied on",
  "5.01": "a change in control",
  "5.02": "an officer or director change",
  "5.03": "amended its charter or bylaws",
  "5.07": "shareholder vote results",
  "7.01": "a Regulation FD disclosure",
  "8.01": "other events",
};

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

/** Every `<name>…</name>` body, ignoring namespaces on the tag. */
function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g"))].map((m) => m[1]!);
}

/** The first `<name>` field's text, through a `<value>` wrapper if it has one; null if missing or empty. */
function field(xml: string, name: string): string | null {
  const b = blocks(xml, name)[0];
  if (b === undefined) return null;
  const v = xmlText(blocks(b, "value")[0] ?? b);
  return v === "" ? null : v;
}

const decimal = /^\d+(\.\d+)?$/;
const yes = (v: string | null) => v === "1" || v === "true";

export interface Form4 {
  /** Each reporting person, and their relationship: "Director", an officer title, "10% owner" or "Other". */
  owners: { name: string; role: string }[];
  officerOrDirector: boolean;
  /** Ticked as a 10b5-1 plan trade, or a footnote says so. */
  planned: boolean;
  /** Open-market sales (code S) and purchases (code P): shares, and dollars where each price is given. */
  sold: { shares: string; value: string | null } | null;
  bought: { shares: string; value: string | null } | null;
  /** Every transaction code, e.g. ["M", "S", "F"]. */
  codes: string[];
}

/** A Form 4's XML: who reported, and what they bought or sold on the open market. */
export function parseForm4(xml: string): Form4 {
  const owners = blocks(xml, "reportingOwner").map((o) => {
    const rel = blocks(o, "reportingOwnerRelationship")[0] ?? "";
    const role = yes(field(rel, "isOfficer"))
      ? (field(rel, "officerTitle") ?? "Officer")
      : yes(field(rel, "isDirector"))
        ? "Director"
        : yes(field(rel, "isTenPercentOwner"))
          ? "10% owner"
          : "Other";
    return { name: field(o, "rptOwnerName") ?? "unknown", role, director: yes(field(rel, "isDirector")), officer: yes(field(rel, "isOfficer")) };
  });
  const footnotes = blocks(xml, "footnote").join(" ");
  const planned = yes(field(xml, "aff10b5One")) || /10b5-1/i.test(footnotes);

  const codes: string[] = [];
  const totals = { S: { shares: "0", value: "0" as string | null }, P: { shares: "0", value: "0" as string | null } };
  for (const t of blocks(xml, "nonDerivativeTransaction")) {
    const code = field(t, "transactionCode");
    if (!code) continue;
    codes.push(code);
    const dir = field(t, "transactionAcquiredDisposedCode");
    const key = code === "S" && dir === "D" ? "S" : code === "P" && dir === "A" ? "P" : null;
    if (!key) continue;
    const shares = field(t, "transactionShares");
    const price = field(t, "transactionPricePerShare");
    if (!shares || !decimal.test(shares)) continue;
    const sum = totals[key];
    sum.shares = add(sum.shares, shares);
    sum.value = sum.value !== null && price && decimal.test(price) ? add(sum.value, round(mul(shares, price), 2, "half-even")) : null;
  }
  for (const t of blocks(xml, "derivativeTransaction")) {
    const code = field(t, "transactionCode");
    if (code) codes.push(code);
  }
  const total = (k: "S" | "P") => (compare(totals[k].shares, "0") > 0 ? totals[k] : null);
  return {
    owners: owners.map(({ name, role }) => ({ name, role })),
    officerOrDirector: owners.some((o) => o.director || o.officer),
    planned,
    sold: total("S"),
    bought: total("P"),
    codes: [...new Set(codes)],
  };
}

export interface Form144 {
  name: string | null;
  relationship: string | null;
  shares: string | null;
  value: string | null;
  /** As filed, MM/DD/YYYY. */
  approxSaleDate: string | null;
}

/** A Form 144's XML: who plans to sell, and how much. */
export function parseForm144(xml: string): Form144 {
  const value = field(xml, "aggregateMarketValue");
  const shares = field(xml, "noOfUnitsSold");
  return {
    name: field(xml, "nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold"),
    relationship: blocks(xml, "relationshipToIssuer").map(xmlText).join(", ") || null,
    shares: shares && decimal.test(shares) ? shares : null,
    value: value && decimal.test(value) ? value : null,
    approxSaleDate: field(xml, "approxSaleDate"),
  };
}

/**
 * Whether an 8-K's text says someone is leaving: a resignation, retirement,
 * stepping down, termination of employment, or not standing for re-election.
 * Item 5.02 also covers appointments and pay, so its title ("Departure of
 * Directors or Certain Officers…") is removed before matching, and so are
 * retirement plans, which pay changes often mention.
 */
export function mentionsDeparture(html: string): boolean {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/departure of directors or (certain )?(principal )?officers/gi, " ")
    .replace(/retirement (plans?|savings|benefits?|accounts?|income)/gi, " ");
  return /\b(resign(s|ed|ing|ation)?|retire(s|d|ment)?|retiring|step(s|ped|ping)? down|terminat(ed|ion of) (his|her|their|the|its)? ?(employment|service)|will not (stand|seek|be nominated) for re-?election|no longer serve)\b/i.test(text);
}

/** "$523,647.78" → "$524K"; dollars to the nearest thousand or million, for summaries. */
function dollars(value: string): string {
  if (compare(value, "1000000") >= 0) return `$${round(mul(value, "0.000001"), 1, "half-even")}M`;
  if (compare(value, "1000") >= 0) return `$${round(mul(value, "0.001"), 0, "half-even")}K`;
  return `$${round(value, 0, "half-even")}`;
}

const sharesText = (s: string) => `${round(s, 0, "half-even")} shares`;

/** Where a filing's primary document is: the browser view, and the raw file (a Form 4's XML without EDGAR's stylesheet). */
export function filingUrls(f: Pick<IndexedFiling, "cik" | "accession" | "primaryDocument">): { view: string; raw: string } {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${f.accession.replace(/-/g, "")}`;
  if (!f.primaryDocument) return { view: `${base}/`, raw: `${base}/` };
  return { view: `${base}/${f.primaryDocument}`, raw: `${base}/${f.primaryDocument.replace(/^xsl[^/]*\//, "")}` };
}

export interface DescribedFiling {
  kind: FilingKind;
  summary: string;
  sellSignal: SellSignal | null;
  detail: Record<string, unknown>;
}

const who = (owners: Form4["owners"]) => owners.map((o) => `${o.role} ${o.name}`).join(" and ") || "An insider";

/** What a Form 4 says, in plain words. */
export function describeForm4(f: Form4, form = "4"): DescribedFiling {
  const amend = form.endsWith("/A") ? " (amended)" : "";
  const detail = { ...f };
  if (f.sold) {
    const signal = f.officerOrDirector && !f.planned;
    const value = f.sold.value ? ` (about ${dollars(f.sold.value)})` : "";
    return {
      kind: "insider_sale",
      summary: `Form 4${amend}: ${who(f.owners)} sold ${sharesText(f.sold.shares)}${value} on the open market, ${f.planned ? "under a pre-arranged 10b5-1 plan" : "not under a 10b5-1 plan"}.`,
      sellSignal: signal ? "insider_sale" : null,
      detail,
    };
  }
  if (f.bought) {
    const value = f.bought.value ? ` (about ${dollars(f.bought.value)})` : "";
    return { kind: "insider_buy", summary: `Form 4${amend}: ${who(f.owners)} bought ${sharesText(f.bought.shares)}${value} on the open market.`, sellSignal: null, detail };
  }
  return {
    kind: "insider_other",
    summary: `Form 4${amend}: ${who(f.owners)} reported transactions other than open-market trades (codes ${f.codes.join(", ") || "none"}: awards, option exercises, tax withholding or gifts).`,
    sellSignal: null,
    detail,
  };
}

/** What a filing is, from its index row and, for Form 4, Form 144 and an 8-K with item 5.02, its document. */
export async function describeFiling(feed: FilingsFeedPort, f: IndexedFiling): Promise<DescribedFiling> {
  const { raw } = filingUrls(f);
  const form = f.form;
  if (form === "4" || form === "4/A") {
    try {
      return describeForm4(parseForm4(await feed.document(raw)), form);
    } catch (e) {
      return { kind: "insider_other", summary: `Form 4: an insider reported a transaction (the document couldn't be read: ${message(e)}).`, sellSignal: null, detail: {} };
    }
  }
  if (form === "144" || form === "144/A") {
    try {
      const n = parseForm144(await feed.document(raw));
      const person = [n.relationship, n.name].filter(Boolean).join(" ") || "An insider";
      const size = n.value ? ` about ${dollars(n.value)}` : n.shares ? ` ${sharesText(n.shares)}` : "";
      return { kind: "sale_notice", summary: `Form 144: ${person} gave notice of a planned sale of${size || " shares"}${n.approxSaleDate ? ` around ${n.approxSaleDate}` : ""}.`, sellSignal: null, detail: { ...n } };
    } catch (e) {
      return { kind: "sale_notice", summary: `Form 144: an insider gave notice of a planned sale (the document couldn't be read: ${message(e)}).`, sellSignal: null, detail: {} };
    }
  }
  if (form === "8-K" || form === "8-K/A") {
    const named = f.items.map((i) => ITEMS[i]).filter((s): s is string => !!s);
    const what = `${form}: ${named.join("; ") || "exhibits only"}`;
    if (f.items.includes("5.02")) {
      let departure: boolean | null = null;
      try {
        departure = mentionsDeparture(await feed.document(raw));
      } catch {
        departure = null;
      }
      const note = departure ? " It mentions someone resigning, retiring or leaving." : departure === null ? " (The document couldn't be read: open it to see who is changing.)" : " It reads as an appointment or a pay change, not a departure.";
      return { kind: "officer_change", summary: `${what}.${note}`, sellSignal: departure ? "executive_departure" : null, detail: { items: f.items, departure } };
    }
    return { kind: f.items.includes("2.02") ? "results" : "other_8k", summary: `${what}.`, sellSignal: null, detail: { items: f.items } };
  }
  if (/13D/.test(form)) {
    return { kind: "large_holder", summary: `${form}: ${form.endsWith("/A") ? "an update from an investor" : "an investor"} owning over 5% who may seek to influence the company (an activist-style stake).`, sellSignal: null, detail: {} };
  }
  if (/13G/.test(form)) {
    return { kind: "large_holder", summary: `${form}: ${form.endsWith("/A") ? "an update from a passive investor" : "a passive investor"} owning over 5%.`, sellSignal: null, detail: {} };
  }
  return { kind: "periodic", summary: `${form}: the ${form === "10-K" ? "annual" : "quarterly"} report.`, sellSignal: null, detail: {} };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface FilingTarget {
  symbol: string;
  /** The thesis holding it, or null for a watchlist name. */
  thesisId: string | null;
}

/** The names to check: every thesis in the active strategy, then the open watchlist. */
export async function filingTargets(db: Db, now: Date): Promise<FilingTarget[]> {
  const theses = (await activeStrategy(db, now)).strategy.conviction.map((t) => ({ symbol: t.symbol, thesisId: t.id }));
  const held = new Set(theses.map((t) => t.symbol));
  const watched = (await readWatchlist(db, now, 0)).open.filter((e) => !held.has(e.symbol)).map((e) => ({ symbol: e.symbol, thesisId: null }));
  return [...theses, ...watched];
}

export interface CheckFilingsResult {
  checked: number;
  /** Filings stored for the first time. */
  stored: number;
  /** Of those, how many were recent enough to report. */
  reported: number;
  sellSignals: number;
  pruned: number;
  failed: { symbol: string; error: string }[];
  /** Names left unchecked because the time budget ran out; they're checked next run. */
  skipped: string[];
}

const DAY_MS = 86_400_000;

/**
 * Read each target's recent EDGAR filings, store the new ones described,
 * and report them: one digest event listing every recent new filing, and an
 * urgent event per sell signal on a held name. Idempotent: a filing already
 * stored isn't read or reported again. A name SEC can't read is skipped and
 * listed; if none could be read, it throws, so the job records a failure.
 */
export async function checkFilings(db: Db, feed: FilingsFeedPort, targets: FilingTarget[], now: Date, clock: () => number = Date.now): Promise<CheckFilingsResult> {
  const started = clock();
  const from = marketDate(new Date(now.getTime() - FILINGS_LIMITS.lookbackDays * DAY_MS));
  const recent = marketDate(new Date(now.getTime() - FILINGS_LIMITS.alertWithinDays * DAY_MS));
  const result: CheckFilingsResult = { checked: 0, stored: 0, reported: 0, sellSignals: 0, pruned: 0, failed: [], skipped: [] };
  const reported: Record<string, unknown>[] = [];

  for (const [i, target] of targets.entries()) {
    if (clock() - started > FILINGS_LIMITS.budgetMs) {
      result.skipped = targets.slice(i).map((t) => t.symbol);
      break;
    }
    const { symbol, thesisId } = target;
    try {
      const rows = (await feed.recentFilings(symbol)).filter((f) => TRACKED.test(f.form) && f.filedOn >= from);
      result.checked++;
      if (rows.length === 0) continue;
      const known = new Set(
        (
          await db
            .select({ accession: secFilings.accession })
            .from(secFilings)
            .where(and(eq(secFilings.symbol, symbol), inArray(secFilings.accession, rows.map((r) => r.accession))))
        ).map((r) => r.accession),
      );
      for (const f of rows.filter((r) => !known.has(r.accession))) {
        const d = await describeFiling(feed, f);
        const [row] = await db
          .insert(secFilings)
          .values({ accession: f.accession, symbol, cik: f.cik, form: f.form, filedOn: f.filedOn, acceptedAt: new Date(f.acceptedAt), items: f.items.join(","), url: filingUrls(f).view, kind: d.kind, summary: d.summary, sellSignal: d.sellSignal, detail: d.detail, seenAt: now })
          .onConflictDoNothing()
          .returning();
        if (!row) continue;
        result.stored++;
        if (f.filedOn < recent || d.kind === "insider_other") continue;
        result.reported++;
        reported.push({ symbol, thesisId, form: f.form, filedOn: f.filedOn, kind: d.kind, summary: d.summary, sellSignal: d.sellSignal, url: row.url });
        if (thesisId && d.sellSignal) {
          result.sellSignals++;
          await recordEvent(db, {
            actor: "system",
            kind: "filing.sell_signal",
            subject: symbol,
            payload: { thesisId, signal: d.sellSignal, form: f.form, filedOn: f.filedOn, accession: f.accession, summary: d.summary, url: row.url },
          });
        }
      }
    } catch (e) {
      result.failed.push({ symbol, error: message(e).slice(0, 300) });
    }
  }

  if (reported.length) await recordEvent(db, { actor: "system", kind: "filings.noticed", subject: [...new Set(reported.map((r) => r.symbol))].join(", "), payload: { filings: reported } });
  const cutoff = marketDate(new Date(now.getTime() - FILINGS_LIMITS.keepDays * DAY_MS));
  result.pruned = (await db.delete(secFilings).where(lt(secFilings.filedOn, cutoff)).returning({ a: secFilings.accession })).length;

  if (targets.length > 0 && result.checked === 0 && result.failed.length > 0) throw new Error(`SEC EDGAR couldn't be read for any of ${result.failed.length} names: ${result.failed[0]!.error}`);
  return result;
}

export interface FilingNote {
  filedOn: string;
  form: string;
  kind: FilingKind;
  summary: string;
  url: string;
  sellSignal?: SellSignal;
}

/**
 * Each symbol's stored filings since its date, newest first, at most
 * FILINGS_LIMITS.perName. Form 4s that aren't open-market trades (awards,
 * exercises, tax withholding) are left out as noise.
 */
export async function filingsSince(db: Db, since: Map<string, string>): Promise<Map<string, FilingNote[]>> {
  const out = new Map<string, FilingNote[]>();
  if (since.size === 0) return out;
  const earliest = [...since.values()].reduce((a, b) => (b < a ? b : a));
  const rows = await db
    .select()
    .from(secFilings)
    .where(and(inArray(secFilings.symbol, [...since.keys()]), gte(secFilings.filedOn, earliest), ne(secFilings.kind, "insider_other")))
    .orderBy(desc(secFilings.acceptedAt));
  for (const r of rows) {
    if (r.filedOn < since.get(r.symbol)!) continue;
    const list = out.get(r.symbol) ?? [];
    if (list.length >= FILINGS_LIMITS.perName) continue;
    list.push({ filedOn: r.filedOn, form: r.form, kind: r.kind as FilingKind, summary: r.summary, url: r.url, ...(r.sellSignal ? { sellSignal: r.sellSignal as SellSignal } : {}) });
    out.set(r.symbol, list);
  }
  return out;
}

/** When the last filings check finished, for the tools: stale after FILINGS_LIMITS.staleAfterHours, with a note saying what to do. */
export async function filingsStatus(db: Db, now: Date): Promise<{ checkedAt: string | null; stale: boolean; note?: string }> {
  const [last] = await db
    .select({ at: jobRuns.finishedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "check-filings"), eq(jobRuns.status, "succeeded")))
    .orderBy(desc(jobRuns.scheduledFor))
    .limit(1);
  const at = last?.at ?? null;
  if (!at) return { checkedAt: null, stale: true, note: "No filings check has run yet: read each name's recent filings on EDGAR yourself." };
  const stale = now.getTime() - at.getTime() > FILINGS_LIMITS.staleAfterHours * 3_600_000;
  return { checkedAt: at.toISOString(), stale, ...(stale ? { note: `The last filings check finished at ${at.toISOString()}, over ${FILINGS_LIMITS.staleAfterHours} hours ago: check EDGAR for anything newer.` } : {}) };
}
