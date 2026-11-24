import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type OwnershipFiling,
  filingLagDays,
  normalizeCusip,
  ownershipFilings,
  parseCoverText,
  parseCoverXml,
  parseHeader,
  parseIndex,
  resolveFromHeader,
  resolveParties,
} from "../../src/research/ownership-filings.js";

// Real files cut from EDGAR (Feb 14, 2019 and Feb 14, 2025: the annual 13G deadline, so every case turns up).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "13d");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

// CIKs that file 13F-HR, as research:13f's filers.json lists them.
const MANAGERS = new Set(["0001510281", "0000764532", "0000104889", "0001426092", "0001317348", "0000080255", "0000898286", "0001000275", "0000927971", "0001595888"]);

const byAccession = (filings: OwnershipFiling[], accession: string) => {
  const f = filings.find((x) => x.accession === accession);
  if (!f) throw new Error(`no filing ${accession}`);
  return f;
};

describe("parseIndex", () => {
  it("reads every row after the dashed line, CIKs padded and dates ISO", () => {
    const rows = parseIndex(fixture("master.20190214.idx"));
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({
      cik: "0001000228",
      name: "HENRY SCHEIN INC",
      form: "SC 13G/A",
      filedOn: "2019-02-14",
      accession: "0000080255-19-002372",
      path: "edgar/data/1000228/0000080255-19-002372.txt",
    });
  });
});

describe("ownershipFilings", () => {
  it("groups the old form names by accession, and skips 13F-HR and 13E-3 rows", () => {
    const filings = ownershipFilings(parseIndex(fixture("master.20190214.idx")));
    expect(filings).toHaveLength(7);
    const saba = byAccession(filings, "0001062993-19-000789");
    expect(saba).toMatchObject({ form: "13D", amendment: false, filedOn: "2019-02-14" });
    expect(saba.parties.map((p) => p.cik)).toEqual(["0001510281", "0001568292"]);
    expect(byAccession(filings, "0000080255-19-002372")).toMatchObject({ form: "13G", amendment: true });
  });

  it("reads the new form names (SCHEDULE 13D, SCHEDULE 13G, /A) from Dec 2024", () => {
    const filings = ownershipFilings(parseIndex(fixture("master.20250214.idx")));
    expect(filings).toHaveLength(6);
    expect(byAccession(filings, "0001104659-25-014235")).toMatchObject({ form: "13D", amendment: false });
    expect(byAccession(filings, "0001595888-25-000074")).toMatchObject({ form: "13G", amendment: false });
    expect(filings.filter((f) => f.amendment)).toHaveLength(2);
  });
});

describe("resolveParties", () => {
  const old = ownershipFilings(parseIndex(fixture("master.20190214.idx")));
  const recent = ownershipFilings(parseIndex(fixture("master.20250214.idx")));

  it("resolves a pair without a header: the 13F filer is the investor, the other party the company", () => {
    expect(resolveParties(byAccession(old, "0001062993-19-000789"), MANAGERS)).toEqual({
      status: "resolved",
      subject: { cik: "0001568292", name: "Ivy High Income Opportunities Fund" },
      filers: [{ cik: "0001510281", name: "Saba Capital Management, L.P." }],
    });
    expect(resolveParties(byAccession(recent, "0001104659-25-014235"), MANAGERS)).toMatchObject({ status: "resolved", subject: { cik: "0001173382" } });
  });

  it("needs the header when both parties file 13Fs (a manager's stake in a company that also files them)", () => {
    expect(resolveParties(byAccession(old, "0000764532-19-000006"), MANAGERS)).toEqual({ status: "needs header" });
    expect(resolveParties(byAccession(recent, "0001085146-25-001407"), MANAGERS)).toEqual({ status: "needs header" });
  });

  it("needs the header when the index lists only one party, if it's a manager", () => {
    expect(resolveParties(byAccession(old, "0001317348-19-000002"), MANAGERS)).toEqual({ status: "needs header" });
  });

  it("drops filings with no 13F filer: individuals and companies", () => {
    expect(resolveParties(byAccession(old, "0001104659-19-008823"), MANAGERS)).toEqual({ status: "no manager" });
    expect(resolveParties(byAccession(old, "0001674796-19-000019"), MANAGERS)).toEqual({ status: "no manager" });
    expect(resolveParties(byAccession(recent, "0000950170-25-021290"), MANAGERS)).toEqual({ status: "no manager" });
  });

  it("with a list of issuers, sends a pair whose other party isn't a listed company to the header", () => {
    const saba = byAccession(old, "0001062993-19-000789");
    expect(resolveParties(saba, MANAGERS, new Set(["0001568292"]))).toMatchObject({ status: "resolved" });
    expect(resolveParties(saba, MANAGERS, new Set(["0000000001"]))).toEqual({ status: "needs header" });
  });
});

describe("parseHeader and resolveFromHeader", () => {
  it("reads the .hdr.sgml tag form", () => {
    const header = parseHeader(fixture("graham-13g.hdr.sgml"));
    expect(header).toEqual({
      subject: { cik: "0000104889", name: "Graham Holdings Co" },
      filedBy: [{ cik: "0000764532", name: "FIDUCIARY MANAGEMENT INC /WI/" }],
    });
    expect(resolveFromHeader(header, MANAGERS)).toEqual({ status: "resolved", subject: header.subject, filers: header.filedBy });
  });

  it("reads the text form at the top of a full submission", () => {
    expect(parseHeader(fixture("saba-13d-header.txt"))).toEqual({
      subject: { cik: "0001568292", name: "Ivy High Income Opportunities Fund" },
      filedBy: [{ cik: "0001510281", name: "Saba Capital Management, L.P." }],
    });
  });

  it("marks a company filing on itself, and a filer that isn't a manager", () => {
    const self = { subject: { cik: "0001317348", name: "Milestone" }, filedBy: [{ cik: "0001317348", name: "Milestone" }] };
    expect(resolveFromHeader(self, MANAGERS)).toEqual({ status: "self" });
    const person = { subject: { cik: "0000104889", name: "Graham" }, filedBy: [{ cik: "0000000042", name: "A PERSON" }] };
    expect(resolveFromHeader(person, MANAGERS)).toEqual({ status: "no manager" });
    expect(resolveFromHeader({ subject: null, filedBy: [] }, MANAGERS)).toEqual({ status: "needs header" });
  });
});

describe("cover pages", () => {
  it("reads a Schedule 13D's XML cover: issuer, CUSIP, percent, event date, and a 13G turned 13D", () => {
    expect(parseCoverXml(fixture("cae-13d.xml"))).toEqual({
      issuerCik: "0001173382",
      cusip: "124765108",
      percentOfClass: 9.7,
      eventDate: "2025-02-13",
      fromThirteenG: true,
    });
  });

  it("reads a Schedule 13G's XML cover (its own field names), taking the largest percent", () => {
    expect(parseCoverXml(fixture("janestreet-13g.xml"))).toEqual({
      issuerCik: "0001017491",
      cusip: "81577F406",
      percentOfClass: 6.6,
      eventDate: "2024-12-31",
      fromThirteenG: null,
    });
  });

  it("reads a text 13D cover before Dec 2024", () => {
    expect(parseCoverText(fixture("saba-13d-cover.htm"))).toEqual({
      issuerCik: null,
      cusip: "465893105",
      percentOfClass: 8.04,
      eventDate: "2019-02-13",
      fromThirteenG: true,
    });
  });

  it("reads a text 13G cover that gives an ISIN for the CUSIP", () => {
    expect(parseCoverText(fixture("longview-13g-cover.htm"))).toEqual({
      issuerCik: null,
      cusip: "806407102",
      percentOfClass: 8.7,
      eventDate: "2018-12-31",
      fromThirteenG: null,
    });
  });

  it("finds a CUSIP written in parts, and returns nulls for a cover it can't read", () => {
    expect(parseCoverText("<p>465893 10 5</p><p>(CUSIP Number)</p>").cusip).toBe("465893105");
    expect(parseCoverText("<p>no cover here</p>")).toEqual({ issuerCik: null, cusip: null, percentOfClass: null, eventDate: null, fromThirteenG: null });
  });
});

describe("normalizeCusip", () => {
  it("accepts a CUSIP with a valid check digit, spaced or as a US ISIN, and rejects the rest", () => {
    expect(normalizeCusip("037833100")).toBe("037833100");
    expect(normalizeCusip("037833 10 0")).toBe("037833100");
    expect(normalizeCusip("US0378331005")).toBe("037833100");
    expect(normalizeCusip("037833101")).toBeNull();
    expect(normalizeCusip("Securities")).toBeNull();
  });
});

describe("filingLagDays", () => {
  it("counts calendar days from the crossing to the filing", () => {
    expect(filingLagDays("2019-02-13", "2019-02-14")).toBe(1);
    expect(filingLagDays("2024-12-31", "2025-02-14")).toBe(45);
    expect(filingLagDays(null, "2025-02-14")).toBeNull();
  });
});
