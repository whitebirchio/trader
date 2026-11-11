import { beforeEach, describe, expect, it } from "vitest";
import {
  FILINGS_LIMITS,
  checkFilings,
  describeFiling,
  describeForm4,
  filingTargets,
  filingUrls,
  filingsSince,
  filingsStatus,
  mentionsDeparture,
  parseForm144,
  parseForm4,
} from "../../src/agent/filings.js";
import type { FilingsFeedPort, IndexedFiling } from "../../src/agent/sec.js";
import { updateWatchlist } from "../../src/agent/watchlist.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, jobRuns, secFilings } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { FakeMailer } from "../notifications/fake-mailer.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

/** A Form 4 in EDGAR's shape, trimmed to the fields read. */
function form4(o: { owner?: string; officer?: string; director?: boolean; tenPct?: boolean; aff10b5One?: string; footnote?: string; rows?: [code: string, ad: string, shares: string, price?: string][]; derivative?: string[] }): string {
  const rows = (o.rows ?? [])
    .map(
      ([code, ad, shares, price]) => `
    <nonDerivativeTransaction>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>${shares}</value></transactionShares>
        ${price ? `<transactionPricePerShare><value>${price}</value></transactionPricePerShare>` : "<transactionPricePerShare><footnoteId id=\"F1\"/></transactionPricePerShare>"}
        <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>`,
    )
    .join("");
  const derivative = (o.derivative ?? []).map((c) => `<derivativeTransaction><transactionCoding><transactionCode>${c}</transactionCode></transactionCoding></derivativeTransaction>`).join("");
  return `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001293167</rptOwnerCik><rptOwnerName>${o.owner ?? "Roe Alex"}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>${o.director ? 1 : 0}</isDirector>
      <isOfficer>${o.officer ? 1 : 0}</isOfficer>
      <isTenPercentOwner>${o.tenPct ? 1 : 0}</isTenPercentOwner>
      ${o.officer ? `<officerTitle>${o.officer}</officerTitle>` : ""}
    </reportingOwnerRelationship>
  </reportingOwner>
  ${o.aff10b5One !== undefined ? `<aff10b5One>${o.aff10b5One}</aff10b5One>` : ""}
  <nonDerivativeTable>${rows}</nonDerivativeTable>
  <derivativeTable>${derivative}</derivativeTable>
  <footnotes>${o.footnote ? `<footnote id="F1">${o.footnote}</footnote>` : ""}</footnotes>
</ownershipDocument>`;
}

describe("parseForm4 and describeForm4 (#105)", () => {
  it("adds up an officer's open-market purchases across rows", () => {
    const f = parseForm4(form4({ officer: "EVP &amp; CFO", rows: [["P", "A", "540", "185.098"], ["P", "A", "541", "184.56"]] }));
    expect(f).toMatchObject({ owners: [{ name: "Roe Alex", role: "EVP & CFO" }], officerOrDirector: true, planned: false, bought: { shares: "1081", value: "199799.88" }, sold: null, codes: ["P"] });
    expect(describeForm4(f)).toMatchObject({ kind: "insider_buy", sellSignal: null, summary: "Form 4: EVP & CFO Roe Alex bought 1081 shares (about $200K) on the open market." });
  });

  it("calls a director's sale outside a 10b5-1 plan a sell signal", () => {
    const d = describeForm4(parseForm4(form4({ owner: "Doe Jane", director: true, aff10b5One: "0", rows: [["S", "D", "10000", "50"]] })));
    expect(d).toMatchObject({ kind: "insider_sale", sellSignal: "insider_sale" });
    expect(d.summary).toBe("Form 4: Director Doe Jane sold 10000 shares (about $500K) on the open market, not under a 10b5-1 plan.");
  });

  it("doesn't flag a sale under a 10b5-1 plan, whether ticked or footnoted, nor a 10% owner's sale", () => {
    expect(describeForm4(parseForm4(form4({ officer: "CEO", aff10b5One: "1", rows: [["S", "D", "100", "10"]] })))).toMatchObject({ kind: "insider_sale", sellSignal: null });
    const footnoted = parseForm4(form4({ officer: "CEO", footnote: "Sold pursuant to a Rule 10b5-1 trading plan adopted on May 1, 2026.", rows: [["S", "D", "100", "10"]] }));
    expect(footnoted.planned).toBe(true);
    expect(describeForm4(parseForm4(form4({ tenPct: true, rows: [["S", "D", "100", "10"]] })))).toMatchObject({ kind: "insider_sale", sellSignal: null, summary: expect.stringContaining("10% owner") });
  });

  it("leaves the dollar value out when a price is missing, and treats awards, exercises and withholding as other", () => {
    expect(parseForm4(form4({ director: true, rows: [["S", "D", "100"]] })).sold).toEqual({ shares: "100", value: null });
    const other = parseForm4(form4({ officer: "COO", rows: [["A", "A", "500"], ["F", "D", "120", "60"]], derivative: ["M"] }));
    expect(other).toMatchObject({ sold: null, bought: null, codes: ["A", "F", "M"] });
    expect(describeForm4(other, "4/A")).toMatchObject({ kind: "insider_other", sellSignal: null, summary: expect.stringMatching(/^Form 4 \(amended\): COO .*\(codes A, F, M/) });
  });
});

describe("parseForm144", () => {
  it("reads who plans to sell, and how much", () => {
    const xml = `<edgarSubmission xmlns="http://www.sec.gov/edgar/ownership" xmlns:com="http://www.sec.gov/edgar/common"><formData><issuerInfo>
      <nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>Smith Pat</nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>
      <relationshipsToIssuer><relationshipToIssuer>Officer</relationshipToIssuer></relationshipsToIssuer></issuerInfo>
      <securitiesInformation><noOfUnitsSold>2994</noOfUnitsSold><aggregateMarketValue>523647.78</aggregateMarketValue><approxSaleDate>11/09/2026</approxSaleDate></securitiesInformation></formData></edgarSubmission>`;
    expect(parseForm144(xml)).toEqual({ name: "Smith Pat", relationship: "Officer", shares: "2994", value: "523647.78", approxSaleDate: "11/09/2026" });
  });
});

describe("mentionsDeparture", () => {
  const item = "<p>Item 5.02 Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers.</p>";
  it("finds a resignation, retirement or stepping down, but not item 5.02's own title", () => {
    expect(mentionsDeparture(`${item}<p>On November 9, 2026, John Smith notified the Board of his resignation as Chief Executive Officer.</p>`)).toBe(true);
    expect(mentionsDeparture(`${item}<p>Ms.&nbsp;Lee will retire as Chief Financial Officer effective December 31.</p>`)).toBe(true);
    expect(mentionsDeparture(`${item}<p>Mr. Park informed the Company that he will not stand for re-election at the annual meeting.</p>`)).toBe(true);
    expect(mentionsDeparture(`${item}<p>The Board appointed Maria Chen as Chief Operating Officer, effective November 15.</p>`)).toBe(false);
    expect(mentionsDeparture(`${item}<p>The Compensation Committee amended the Supplemental Executive Retirement Plan.</p>`)).toBe(false);
  });
});

describe("filingUrls", () => {
  it("links the browser view and the raw document, without EDGAR's stylesheet folder", () => {
    expect(filingUrls({ cik: "0000350698", accession: "0001293167-26-000008", primaryDocument: "xslF345X06/wk-form4_1794258585.xml" })).toEqual({
      view: "https://www.sec.gov/Archives/edgar/data/350698/000129316726000008/xslF345X06/wk-form4_1794258585.xml",
      raw: "https://www.sec.gov/Archives/edgar/data/350698/000129316726000008/wk-form4_1794258585.xml",
    });
  });
});

const NOW = new Date("2026-11-11T15:00:00Z");
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

function indexed(o: Partial<IndexedFiling> & { accession: string; form: string; daysAgo: number }): IndexedFiling {
  const filedOn = day(o.daysAgo);
  return { cik: "0001065696", items: [], primaryDocument: `doc-${o.accession}.htm`, acceptedAt: `${filedOn}T13:00:00.000Z`, filedOn, ...o };
}

/** A fake EDGAR: each symbol's index, and each raw document's text. */
function feed(index: Record<string, IndexedFiling[] | Error>, docs: Record<string, string | Error> = {}): FilingsFeedPort & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async recentFilings(symbol) {
      const r = index[symbol] ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    async document(url) {
      reads.push(url);
      const name = url.split("/").at(-1)!;
      const d = docs[name];
      if (d === undefined) throw new Error(`${url}: HTTP 404`);
      if (d instanceof Error) throw d;
      return d;
    },
  };
}

describe("describeFiling", () => {
  it("names 8-K items, and reads item 5.02's text for a departure; says so when it can't", async () => {
    const f = feed({}, { "doc-a.htm": "<p>Item 5.02 Departure of Directors or Certain Officers.</p><p>Our CEO has resigned.</p>" });
    expect(await describeFiling(f, indexed({ accession: "a", form: "8-K", daysAgo: 1, items: ["5.02", "9.01"] }))).toMatchObject({
      kind: "officer_change",
      sellSignal: "executive_departure",
      summary: "8-K: an officer or director change. It mentions someone resigning, retiring or leaving.",
    });
    expect(await describeFiling(f, indexed({ accession: "b", form: "8-K", daysAgo: 1, items: ["5.02"] }))).toMatchObject({ kind: "officer_change", sellSignal: null, detail: { departure: null } });
    expect(await describeFiling(f, indexed({ accession: "c", form: "8-K", daysAgo: 1, items: ["2.02", "9.01"] }))).toMatchObject({ kind: "results", summary: "8-K: results of operations." });
    expect(await describeFiling(f, indexed({ accession: "d", form: "SCHEDULE 13D", daysAgo: 1 }))).toMatchObject({ kind: "large_holder", summary: expect.stringContaining("activist-style") });
    expect(await describeFiling(f, indexed({ accession: "e", form: "10-Q", daysAgo: 1 }))).toMatchObject({ kind: "periodic", summary: "10-Q: the quarterly report." });
  });

  it("still records a Form 4 or Form 144 whose document can't be read", async () => {
    const f = feed({});
    expect(await describeFiling(f, indexed({ accession: "x", form: "4", daysAgo: 1 }))).toMatchObject({ kind: "insider_other", sellSignal: null, summary: expect.stringContaining("couldn't be read") });
    expect(await describeFiling(f, indexed({ accession: "y", form: "144", daysAgo: 1 }))).toMatchObject({ kind: "sale_notice", summary: expect.stringContaining("couldn't be read") });
  });
});

let db: Db;
beforeEach(async () => {
  ({ db } = await createTestDb());
});

const events = async () => (await db.select().from(auditEvents)).filter((e) => e.kind.startsWith("filing"));
const sale = form4({ owner: "Doe Jane", director: true, rows: [["S", "D", "1000", "40"]] });
const award = form4({ officer: "CFO", rows: [["A", "A", "500"]] });

describe("checkFilings", () => {
  it("stores new tracked filings, emails a held name's sell signal, and puts the rest in one digest event", async () => {
    const f = feed(
      {
        LKQ: [
          indexed({ accession: "k1", form: "8-K", daysAgo: 1, items: ["5.02", "9.01"] }),
          indexed({ accession: "k2", form: "4", daysAgo: 2 }),
          indexed({ accession: "k3", form: "4", daysAgo: 2 }),
          indexed({ accession: "k4", form: "S-8", daysAgo: 1 }), // not tracked
          indexed({ accession: "k5", form: "10-Q", daysAgo: 10 }), // stored, but too old to report
          indexed({ accession: "k6", form: "8-K", daysAgo: 45, items: ["8.01"] }), // past the lookback
        ],
        CWST: [indexed({ accession: "c1", cik: "0000911177", form: "4", daysAgo: 0 })],
      },
      { "doc-k1.htm": "<p>The CFO resigned.</p>", "doc-k2.htm": sale, "doc-k3.htm": award, "doc-c1.htm": sale },
    );
    const r = await checkFilings(db, f, [{ symbol: "LKQ", thesisId: "lkq-1" }, { symbol: "CWST", thesisId: null }], NOW);
    expect(r).toEqual({ checked: 2, stored: 5, reported: 3, sellSignals: 2, pruned: 0, failed: [], skipped: [] });

    const e = await events();
    expect(e.filter((x) => x.kind === "filing.sell_signal").map((x) => [x.subject, x.payload.signal])).toEqual([
      ["LKQ", "executive_departure"],
      ["LKQ", "insider_sale"],
    ]);
    const [noticed] = e.filter((x) => x.kind === "filings.noticed");
    expect(noticed!.subject).toBe("LKQ, CWST");
    // The award isn't reported; the watchlist name's sale is, without an urgent email.
    expect((noticed!.payload.filings as { symbol: string; form: string; sellSignal: string | null; thesisId: string | null }[]).map((x) => [x.symbol, x.form, x.sellSignal, x.thesisId])).toEqual([
      ["LKQ", "8-K", "executive_departure", "lkq-1"],
      ["LKQ", "4", "insider_sale", "lkq-1"],
      ["CWST", "4", "insider_sale", null],
    ]);
  });

  it("reads nothing twice: a second check of the same index stores and reports nothing", async () => {
    const f = feed({ LKQ: [indexed({ accession: "k2", form: "4", daysAgo: 1 })] }, { "doc-k2.htm": sale });
    await checkFilings(db, f, [{ symbol: "LKQ", thesisId: "lkq-1" }], NOW);
    const again = await checkFilings(db, f, [{ symbol: "LKQ", thesisId: "lkq-1" }], new Date(NOW.getTime() + 3_600_000));
    expect(again).toMatchObject({ stored: 0, reported: 0, sellSignals: 0 });
    expect(f.reads).toHaveLength(1);
    expect((await events()).filter((x) => x.kind === "filing.sell_signal")).toHaveLength(1);
  });

  it("skips a name SEC can't read and goes on, but fails when none can be read", async () => {
    const f = feed({ BA: new Error("HTTP 503"), LKQ: [indexed({ accession: "k5", form: "10-Q", daysAgo: 1 })] });
    expect(await checkFilings(db, f, [{ symbol: "BA", thesisId: "ba-1" }, { symbol: "LKQ", thesisId: "lkq-1" }], NOW)).toMatchObject({ checked: 1, stored: 1, failed: [{ symbol: "BA", error: "HTTP 503" }] });
    await expect(checkFilings(db, feed({ BA: new Error("HTTP 503") }), [{ symbol: "BA", thesisId: "ba-1" }], NOW)).rejects.toThrow("SEC EDGAR couldn't be read for any of 1 names: HTTP 503");
  });

  it("stops starting names when the time budget runs out, and prunes rows past keepDays", async () => {
    await db.insert(secFilings).values({ accession: "old", symbol: "LKQ", cik: "1", form: "10-Q", filedOn: day(FILINGS_LIMITS.keepDays + 1), acceptedAt: NOW, items: "", url: "u", kind: "periodic", summary: "s" });
    let t = 0;
    const clock = () => (t += FILINGS_LIMITS.budgetMs); // each name "takes" the whole budget
    const r = await checkFilings(db, feed({}), [{ symbol: "LKQ", thesisId: "lkq-1" }, { symbol: "BA", thesisId: "ba-1" }, { symbol: "AN", thesisId: null }], NOW, clock);
    expect(r).toMatchObject({ checked: 1, skipped: ["BA", "AN"], pruned: 1 });
  });
});

describe("filingsSince and filingsStatus", () => {
  it("gives each symbol's filings since its own date, newest first, without non-trade Form 4s", async () => {
    const f = feed(
      { LKQ: [indexed({ accession: "k1", form: "8-K", daysAgo: 1, items: ["2.02"] }), indexed({ accession: "k3", form: "4", daysAgo: 2 }), indexed({ accession: "k5", form: "10-Q", daysAgo: 10 })], AN: [indexed({ accession: "a1", form: "4", daysAgo: 3 })] },
      { "doc-k3.htm": award, "doc-a1.htm": sale },
    );
    await checkFilings(db, f, [{ symbol: "LKQ", thesisId: "lkq-1" }, { symbol: "AN", thesisId: "an-1" }], NOW);
    const got = await filingsSince(db, new Map([["LKQ", day(20)], ["AN", day(1)]]));
    expect(got.get("LKQ")!.map((x) => x.form)).toEqual(["8-K", "10-Q"]);
    expect(got.has("AN")).toBe(false); // its sale is before AN's date
    const an = await filingsSince(db, new Map([["AN", day(5)]]));
    expect(an.get("AN")![0]).toMatchObject({ form: "4", kind: "insider_sale", sellSignal: "insider_sale", url: expect.stringContaining("/doc-a1.htm") });
  });

  it("says when no check has run, and when the last one is stale", async () => {
    expect(await filingsStatus(db, NOW)).toMatchObject({ checkedAt: null, stale: true, note: expect.stringContaining("EDGAR yourself") });
    await db.insert(jobRuns).values({ job: "check-filings", scheduledFor: NOW, status: "succeeded", finishedAt: NOW });
    expect(await filingsStatus(db, new Date(NOW.getTime() + 3_600_000))).toEqual({ checkedAt: NOW.toISOString(), stale: false });
    expect(await filingsStatus(db, new Date(NOW.getTime() + 4 * 3_600_000))).toMatchObject({ stale: true, note: expect.stringContaining("over 3 hours ago") });
  });
});

describe("the check-filings job", () => {
  const deps = (filings?: FilingsFeedPort) => ({ db, env: "staging" as const, broker: new FakeBroker(), mailer: new FakeMailer(), now: () => NOW, ...(filings ? { filings } : {}) });

  it("checks every thesis, then the open watchlist names that aren't theses", async () => {
    await submitStrategy(db, strategy({ conviction: [thesis(), thesis({ id: "lkq-1", symbol: "LKQ" })] }), "claude", NOW);
    const why = "worth a closer look later";
    await updateWatchlist(db, [{ action: "watch", symbol: "CWST", why, trigger: "margins turn in the 10-Q", revisitBy: day(-20) }, { action: "watch", symbol: "LKQ", why, trigger: "a cleaner quarter", revisitBy: day(-20) }], "claude", NOW);
    expect(await filingTargets(db, NOW)).toEqual([
      { symbol: "AAPL", thesisId: "aapl-services" },
      { symbol: "LKQ", thesisId: "lkq-1" },
      { symbol: "CWST", thesisId: null },
    ]);
  });

  it("is skipped without an SEC client or names, and runs about hourly", async () => {
    expect(await runJob(deps(), "check-filings", NOW)).toEqual({ status: "skipped", reason: "no SEC client" });
    const f = feed({});
    expect(await runJob(deps(f), "check-filings", new Date(NOW.getTime() + 60_000))).toEqual({ status: "skipped", reason: "no theses or watchlist names" });
    await submitStrategy(db, strategy(), "claude", NOW);
    const t0 = new Date(NOW.getTime() + 120_000);
    expect(await runJob(deps(f), "check-filings", t0)).toMatchObject({ status: "succeeded", detail: { checked: 1 } });
    expect(await runJob(deps(f), "check-filings", new Date(t0.getTime() + 15 * 60_000))).toMatchObject({ status: "skipped", reason: expect.stringContaining("runs about hourly") });
  });
});
