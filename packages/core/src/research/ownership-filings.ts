/**
 * Schedule 13D and 13G filings for the stakes backtest (#138 Part 2,
 * tasks/13f-backtest-plan.md). Pure: EDGAR's daily index rows, filing
 * headers and cover pages in, ownership filings out. The script
 * (scripts/research-13d.ts) does the fetching.
 *
 * A 13D is filed within 5 business days (10 before Feb 2024) of crossing 5%
 * of a class with intent to influence; a 13G is the passive version. The
 * daily index lists a filing once per entity it names, so the investor and
 * the company it's about share an accession number. Telling them apart:
 * the investor files 13Fs (it's an investment manager), the company doesn't.
 * When that can't decide (both or one row), the filing's header does.
 */

export interface IndexRow {
  cik: string;
  name: string;
  form: string;
  filedOn: string;
  accession: string;
  path: string;
}

/** EDGAR's `master.YYYYMMDD.idx`: rows after the dashed line, `CIK|Company Name|Form Type|Date Filed|File Name`. */
export function parseIndex(text: string): IndexRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^-{10,}/.test(l));
  const rows: IndexRow[] = [];
  for (const line of lines.slice(start + 1)) {
    const parts = line.trim().split("|");
    if (parts.length !== 5) continue;
    const [cik, name, form, date, path] = parts as [string, string, string, string, string];
    if (!/^\d+$/.test(cik) || !/^\d{8}$/.test(date)) continue;
    const accession = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(path)?.[1];
    if (!accession) continue;
    rows.push({ cik: padCik(cik), name: name.trim(), form: form.trim(), filedOn: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`, accession, path });
  }
  return rows;
}

export const padCik = (cik: string) => cik.replace(/^0+/, "").padStart(10, "0");

export interface Party {
  cik: string;
  name: string;
}

export interface OwnershipFiling {
  accession: string;
  form: "13D" | "13G";
  amendment: boolean;
  filedOn: string;
  /** Every entity the index lists the filing under: the investor(s) and the company. */
  parties: Party[];
}

/** Both form-name families: `SC 13D…` and, from Dec 2024, `SCHEDULE 13D…`. */
const OWNERSHIP_FORM = /^(?:SC|SCHEDULE) 13([DG])(\/A)?$/;

/** 13D and 13G rows grouped by accession, in index order. Other forms are skipped. */
export function ownershipFilings(rows: IndexRow[]): OwnershipFiling[] {
  const byAccession = new Map<string, OwnershipFiling>();
  for (const r of rows) {
    const m = OWNERSHIP_FORM.exec(r.form);
    if (!m) continue;
    let f = byAccession.get(r.accession);
    if (!f) {
      f = { accession: r.accession, form: m[1] === "D" ? "13D" : "13G", amendment: m[2] !== undefined, filedOn: r.filedOn, parties: [] };
      byAccession.set(r.accession, f);
    }
    if (!f.parties.some((p) => p.cik === r.cik)) f.parties.push({ cik: r.cik, name: r.name });
  }
  return [...byAccession.values()];
}

export type Resolution =
  | { status: "resolved"; subject: Party; filers: Party[] }
  /** No party files 13Fs: an individual, a company or a fund that isn't an investment manager. */
  | { status: "no manager" }
  /** The investor and the company can't be told apart from the index: read the header. */
  | { status: "needs header" };

/**
 * Investor vs company from the index alone. `managers` holds the CIKs that
 * file 13F-HR. Exactly one party that doesn't file them is the company, and
 * the rest are the investors. When `issuers` (CIKs known to be listed
 * companies) is given, that party must also be one, or the header decides:
 * an individual filing on a company that itself files 13Fs would otherwise
 * be read backwards.
 */
export function resolveParties(filing: OwnershipFiling, managers: ReadonlySet<string>, issuers?: ReadonlySet<string>): Resolution {
  const isManager = filing.parties.map((p) => managers.has(p.cik));
  if (!isManager.some(Boolean)) return { status: "no manager" };
  const others = filing.parties.filter((_, i) => !isManager[i]);
  if (filing.parties.length < 2 || others.length !== 1) return { status: "needs header" };
  const subject = others[0] as Party;
  if (issuers && !issuers.has(subject.cik)) return { status: "needs header" };
  return { status: "resolved", subject, filers: filing.parties.filter((_, i) => isManager[i]) };
}

export interface Header {
  subject: Party | null;
  filedBy: Party[];
}

/** A filing's SEC header: the `.hdr.sgml` tag form, or the text form at the top of the full submission. */
export function parseHeader(text: string): Header {
  const end = text.search(/<\/SEC-HEADER>/);
  const head = end >= 0 ? text.slice(0, end) : text;
  const sections = head.split(/(?=<SUBJECT-COMPANY>|<FILED-BY>|^SUBJECT COMPANY:|^FILED BY:)/m);
  let subject: Party | null = null;
  const filedBy: Party[] = [];
  for (const s of sections) {
    const isSubject = /^(?:<SUBJECT-COMPANY>|SUBJECT COMPANY:)/.test(s);
    const isFiler = /^(?:<FILED-BY>|FILED BY:)/.test(s);
    if (!isSubject && !isFiler) continue;
    const name = /<CONFORMED-NAME>([^\n<]+)|COMPANY CONFORMED NAME:\s*([^\n]+)/.exec(s);
    const cik = /<CIK>(\d+)|CENTRAL INDEX KEY:\s*(\d+)/.exec(s);
    if (!cik) continue;
    const party = { cik: padCik((cik[1] ?? cik[2]) as string), name: ((name?.[1] ?? name?.[2]) ?? "").trim() };
    if (isSubject) subject = party;
    else filedBy.push(party);
  }
  return { subject, filedBy };
}

/** Investor vs company from the header. A filing by the company on itself, or with no 13F filer among its filers, isn't a manager's stake. */
export function resolveFromHeader(header: Header, managers: ReadonlySet<string>): Resolution | { status: "self" } {
  const { subject } = header;
  if (!subject) return { status: "needs header" };
  const filers = header.filedBy.filter((p) => p.cik !== subject.cik);
  if (filers.length === 0) return { status: "self" };
  if (!filers.some((p) => managers.has(p.cik))) return { status: "no manager" };
  return { status: "resolved", subject, filers };
}

export interface Cover {
  issuerCik: string | null;
  cusip: string | null;
  /** The largest percent of class any reporting person claims. Structured from Dec 2024; best effort before. */
  percentOfClass: number | null;
  /** The date of the event that requires the filing (the crossing). */
  eventDate: string | null;
  /** A 13D whose filer had reported the same stake on a 13G: a passive holder turning active. Null when the cover doesn't say. */
  fromThirteenG: boolean | null;
}

const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}>([^<]*)</`, "i").exec(xml)?.[1]?.trim() ?? null;
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</`, "gi"))].map((m) => (m[1] ?? "").trim());

/** The XML cover page (primary_doc.xml), Schedule 13D or 13G, from Dec 2024. */
export function parseCoverXml(xml: string): Cover {
  const percents = [...tags(xml, "percentOfClass"), ...tags(xml, "classPercent")].map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  const event = tag(xml, "dateOfEvent") ?? tag(xml, "eventDateRequiresFilingThisStatement");
  const isThirteenD = /13D/i.test(tag(xml, "submissionType") ?? "") || /edgar\/schedule13D"/i.test(xml);
  const previously = tag(xml, "previouslyFiledFlag");
  const issuerCik = tag(xml, "issuerCIK") ?? tag(xml, "issuerCik");
  return {
    issuerCik: issuerCik ? padCik(issuerCik) : null,
    cusip: normalizeCusip(tag(xml, "issuerCUSIP") ?? tag(xml, "issuerCusip") ?? ""),
    percentOfClass: percents.length ? Math.max(...percents) : null,
    eventDate: event ? usDate(event) : null,
    fromThirteenG: isThirteenD ? previously === "true" : null,
  };
}

/** The text (HTML) cover page, before Dec 2024: the CUSIP reliably, the rest best effort. */
export function parseCoverText(html: string): Cover {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
  const label = /\(CUSIP Number\)/i.exec(text);
  const after = /CUSIP (?:No\.?|Number)\s*:?/i.exec(text);
  const cusip =
    (label ? cusipIn(text.slice(Math.max(0, label.index - 40), label.index).trim().split(" ").reverse(), true) : null) ??
    (after ? cusipIn(text.slice(after.index + after[0].length, after.index + after[0].length + 40).trim().split(" "), false) : null);
  const percents = [...text.matchAll(/PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW \(\d+\)\s*:?\s*([\d.]+)\s*%/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n <= 100);
  const event = /([A-Z][a-z]+\.? \d{1,2}, \d{4}|\d{1,2}\/\d{1,2}\/\d{4})\s*\(Date of Event/i.exec(text)?.[1];
  const box = /previously filed a statement on Schedule 13G.{0,300}?check the following box\.?\s*\[\s*(X|x|\s?)\s*\]/i.exec(text);
  return {
    issuerCik: null,
    cusip,
    percentOfClass: percents.length ? Math.max(...percents) : null,
    eventDate: event ? (event.includes("/") ? usDate(event) : longDate(event)) : null,
    fromThirteenG: box ? /x/i.test(box[1] ?? "") : null,
  };
}

/**
 * The CUSIP among the tokens next to a cover's label: one token, or up to
 * three joined (`465893 10 5`). `reversed` tokens run backwards from the label.
 */
function cusipIn(tokens: string[], reversed: boolean): string | null {
  for (let n = 1; n <= 3; n++) {
    const picked = tokens.slice(0, n);
    const found = normalizeCusip((reversed ? picked.reverse() : picked).join(""));
    if (found) return found;
  }
  return null;
}

/** A 9-character CUSIP with a valid check digit, from a CUSIP (spaces or dashes allowed) or a US ISIN. Null otherwise. */
export function normalizeCusip(raw: string): string | null {
  let s = raw.toUpperCase().replace(/[\s-]/g, "");
  if (/^US[0-9A-Z]{9}\d$/.test(s)) s = s.slice(2, 11);
  if (!/^[0-9A-Z]{8}\d$/.test(s)) return null;
  return cusipCheckDigit(s.slice(0, 8)) === Number(s[8]) ? s : null;
}

function cusipCheckDigit(base: string): number {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const c = base[i] as string;
    let v = /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return (10 - (sum % 10)) % 10;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function usDate(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${(m[1] as string).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}` : null;
}

function longDate(s: string): string | null {
  const m = /^([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.findIndex((n) => n.startsWith((m[1] as string).toLowerCase().slice(0, 3)));
  return month < 0 ? null : `${m[3]}-${String(month + 1).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
}

/** Days from the event (the crossing) to the filing; null without an event date. */
export function filingLagDays(eventDate: string | null, filedOn: string): number | null {
  if (!eventDate) return null;
  return Math.round((Date.parse(`${filedOn}T00:00:00Z`) - Date.parse(`${eventDate}T00:00:00Z`)) / 86_400_000);
}
