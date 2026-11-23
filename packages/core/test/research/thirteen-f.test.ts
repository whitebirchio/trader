import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTsv } from "../../src/research/insider-backtest.js";
import {
  type Filing,
  MANAGER_RULE,
  collapseRelated,
  consensusEvents,
  filingBuilder,
  ftdLinks,
  ftdRow,
  managerSet,
  namedSet,
  noteSymbol,
  overlap,
  parseFigi,
  positionEvents,
  previousQuarter,
  quarterOf,
  quartersHeld,
  qualifies,
  resolveTicker,
  shareRatios,
  toDollars,
  windowLinks,
  windowMeta,
  windowStart,
} from "../../src/research/thirteen-f.js";

// Real rows cut from SEC's Form 13F Data Sets: 2022q4 (values in thousands)
// and 01jun2025-31aug2025 (values in dollars).
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const table = (dir: string, name: string) => parseTsv(readFileSync(join(fixtures, dir, `${name}.tsv`), "utf8"));
const meta = (dir: string) => windowMeta({ submissions: table(dir, "SUBMISSION"), covers: table(dir, "COVERPAGE"), summaries: table(dir, "SUMMARYPAGE") });
function build(dir: string): Filing[] {
  const m = meta(dir);
  const builder = filingBuilder(new Map(m.originals.map((f) => [f.accession, f])));
  for (const row of table(dir, "INFOTABLE")) builder.add(row);
  return builder.filings();
}

describe("windowMeta", () => {
  it("keeps original holdings reports, counting amendments and skipping notices", () => {
    const m = meta("13f-2025");
    expect(m.originals.map((f) => [f.cik, f.manager, f.period, f.filedOn])).toEqual([
      ["0002026053", "PERSHING SQUARE HOLDCO, L.P.", "2025-06-30", "2025-08-14"],
      ["0001336528", "Pershing Square Capital Management, L.P.", "2025-06-30", "2025-08-14"],
    ]);
    expect(m.amendments).toBe(1); // Berkshire's 13F-HR/A for Q1
    expect(m.filers).toEqual(["0001336528", "0002026053"]);
    expect(m.late).toBe(0);
  });

  it("leaves out an original filed long after its period", () => {
    const submissions = table("13f-2025", "SUBMISSION").map((r) => (r.CIK === "0001336528" ? { ...r, FILING_DATE: "01-DEC-2025" } : r));
    const m = windowMeta({ submissions, covers: table("13f-2025", "COVERPAGE"), summaries: table("13f-2025", "SUMMARYPAGE") });
    expect(m.originals.map((f) => f.cik)).toEqual(["0002026053"]);
    expect(m.late).toBe(1);
    expect(m.filers).toContain("0001336528");
  });
});

describe("filingBuilder", () => {
  it("converts pre-2023 values from thousands, and drops options and notes", () => {
    const filings = build("13f-2022");
    const pershing = filings.find((f) => f.cik === "0001336528");
    const other = filings.find((f) => f.cik !== "0001336528");
    expect(pershing!.manager).toMatch(/Pershing/);
    expect(pershing!.positions).toHaveLength(6);
    expect(pershing!.positions[0]).toEqual({ cusip: "548661107", issuer: "LOWES COS INC", value: 1_948_491_000, shares: 10_374_801 });
    // PRN notes and the two call rows are gone; Palantir keeps only its share row.
    expect(other!.positions.map((p) => [p.cusip, p.value])).toEqual([
      ["037833100", 13_743_000],
      ["594918104", 8_324_000],
      ["69608A108", 180_000],
    ]);
    expect(other!.unitsCorrected).toBeUndefined();
  });

  it("reads 2025 values as dollars, largest first", () => {
    const pscm = build("13f-2025").find((f) => f.cik === "0001336528")!;
    expect(pscm.positions).toHaveLength(11);
    expect(pscm.positions[0]).toMatchObject({ issuer: "UBER TECHNOLOGIES INC", value: 2_827_098_321 });
  });

  it("sums rows for the same CUSIP", () => {
    const f = { accession: "a", cik: "1", manager: "M", period: "2025-06-30", filedOn: "2025-08-14", entries: 2 };
    const b = filingBuilder(new Map([["a", f]]));
    const row = { ACCESSION_NUMBER: "a", NAMEOFISSUER: "X", CUSIP: "123456789", VALUE: "1000", SSHPRNAMT: "10", SSHPRNAMTTYPE: "SH", PUTCALL: "" };
    b.add(row);
    b.add({ ...row, VALUE: "500", SSHPRNAMT: "5" });
    b.add({ ...row, ACCESSION_NUMBER: "other" });
    expect(b.filings()[0]!.positions).toEqual([{ cusip: "123456789", issuer: "X", value: 1500, shares: 15 }]);
  });
});

describe("toDollars", () => {
  const p = (value: number, shares: number) => ({ cusip: "123456789", issuer: "X", value, shares });
  it("fixes a filer that used the wrong unit for its era", () => {
    // Filed in 2022 but in dollars: $100/share would read as $100,000.
    expect(toDollars([p(10_000, 100)], "2022-11-14")).toEqual({ positions: [p(10_000, 100)], corrected: true });
    // Filed in 2024 but in thousands: $100/share would read as $0.10.
    expect(toDollars([p(10, 100)], "2024-02-14")).toEqual({ positions: [p(10_000, 100)], corrected: true });
    expect(toDollars([p(10, 100)], "2022-11-14")).toEqual({ positions: [p(10_000, 100)], corrected: false });
  });
});

describe("quarters", () => {
  it("names quarters and steps back across a year", () => {
    expect(quarterOf("2025-06-30")).toBe("2025Q2");
    expect(quarterOf("2024-12-31")).toBe("2024Q4");
    expect(previousQuarter("2025Q1")).toBe("2024Q4");
    expect(previousQuarter("2025Q3")).toBe("2025Q2");
  });
});

// Hand-built filings: cusips are "C<n>", padded to nine characters.
const ends = ["03-31", "06-30", "09-30", "12-31"];
const periodOf = (q: string) => `${q.slice(0, 4)}-${ends[Number(q.slice(5)) - 1]}`;
const cusip = (n: number) => `C${String(n).padStart(8, "0")}`;
function filing(cik: string, q: string, held: [number, number, number?][], filedOn?: string): Filing {
  return {
    accession: `${cik}-${q}`,
    cik,
    manager: `M${cik}`,
    period: periodOf(q),
    filedOn: filedOn ?? `${periodOf(q).slice(0, 8)}28`,
    positions: held.map(([n, value, shares]) => ({ cusip: cusip(n), issuer: `I${n}`, value, shares: shares ?? 100 })).sort((a, b) => b.value - a.value),
  };
}
const ten = (value = 2e8): [number, number][] => Array.from({ length: 10 }, (_, i) => [i, value - i]);
const quarters = ["2024Q1", "2024Q2", "2024Q3", "2024Q4", "2025Q1", "2025Q2"];

describe("qualifies", () => {
  const history = (cik: string, qs: string[], held = ten()) => qs.map((q) => filing(cik, q, held));

  it("passes a concentrated manager that has held its book for 4+ quarters", () => {
    const h = history("1", quarters);
    expect(qualifies(h[5]!, h)).toBe(true);
    expect(quartersHeld(cusip(0), "2025Q2", new Map(h.map((f) => [quarterOf(f.period), f])), MANAGER_RULE.heldCap)).toBe(5);
  });

  it("fails too many positions, too little money, or too short a record", () => {
    const wide = history("1", quarters, Array.from({ length: 31 }, (_, i): [number, number] => [i, 1e8]));
    expect(qualifies(wide[5]!, wide)).toBe(false);
    const small = history("1", quarters, ten(1e7));
    expect(qualifies(small[5]!, small)).toBe(false);
    const young = history("1", quarters.slice(2));
    expect(qualifies(young[3]!, young)).toBe(false);
  });

  it("fails a high-turnover manager", () => {
    const h = quarters.map((q, i) => filing("1", q, Array.from({ length: 10 }, (_, j): [number, number] => [i * 10 + j, 2e8])));
    expect(qualifies(h[5]!, h)).toBe(false);
  });

  it("uses only earlier filings, and a missing quarter ends a holding's run", () => {
    const h = history("1", quarters);
    const later = [...h, filing("1", "2025Q3", ten()), filing("1", "2025Q4", ten())];
    expect(qualifies(h[3]!, later)).toBe(qualifies(h[3]!, h.slice(0, 4))); // 3 prior filings: false either way
    expect(qualifies(h[3]!, later)).toBe(false);
    const gap = h.filter((f) => quarterOf(f.period) !== "2025Q1");
    expect(qualifies(h[5]!, gap)).toBe(false); // 4 prior filings, but the run back from 2025Q2 is broken at once
  });
});

describe("managerSet and collapseRelated", () => {
  it("keeps the larger of two filings that are one group's book", () => {
    const a = filing("1", "2025Q2", ten(3e8));
    const b = filing("2", "2025Q2", ten(2e8));
    expect(overlap(a, b)).toBeCloseTo(1);
    expect(collapseRelated([b, a]).map((f) => f.cik)).toEqual(["1"]);
    const c = filing("3", "2025Q2", [[50, 1e9]]);
    expect(collapseRelated([c, a]).map((f) => f.cik)).toEqual(["1", "3"]);
  });

  it("judges each filing on its own manager's history", () => {
    const h1 = quarters.map((q) => filing("1", q, ten()));
    const h2 = quarters.slice(4).map((q) => filing("2", q, [[90, 2e9]]));
    const set = managerSet([h1[5]!, h2[1]!], new Map([["1", h1], ["2", h2]]));
    expect(set.map((f) => f.cik)).toEqual(["1"]);
  });
});

describe("namedSet", () => {
  it("keeps one filing per named manager, the largest", () => {
    const holdco = { ...filing("0002026053", "2025Q2", [[1, 6e8]]) };
    const pscm = { ...filing("0001336528", "2025Q2", ten(1e9)) };
    const other = filing("0000000001", "2025Q2", ten());
    expect(namedSet([holdco, pscm, other]).map((f) => f.cik)).toEqual(["0001336528"]);
  });
});

describe("positionEvents", () => {
  const before = filing("1", "2025Q1", [[1, 5e8, 100], [2, 4e8, 100], [3, 1e8, 100]]);
  const now = filing("1", "2025Q2", [[4, 6e8, 100], [1, 5e8, 100], [2, 4e8, 130], [5, 3e8, 100], [3, 1e8, 300]]);
  const kinds = (events: { kind: string; cusip: string }[]) => events.map((e) => `${e.kind}:${e.cusip.slice(-1)}`);

  it("finds new positions, large adds, the best idea and the top 3", () => {
    const held = new Set([cusip(1), cusip(2), cusip(3), cusip(4)]); // C5 wasn't held by anyone: an IPO or a new CUSIP
    expect(kinds(positionEvents(now, before, held, new Map()))).toEqual(["best:4", "top3:4", "new:4", "newTop5:4", "top3:1", "top3:2", "add:2", "add:3"]);
  });

  it("needs a new top-5 position to be 5% of the book", () => {
    const small = filing("1", "2025Q2", [[1, 9.5e8, 100], [4, 4e7, 100]]); // C4 is new, 2nd largest, but 4% of the book
    expect(kinds(positionEvents(small, before, new Set([cusip(4)]), new Map())).filter((k) => k.endsWith(":4"))).toEqual(["top3:4", "new:4"]);
  });

  it("doesn't read a stock split as an add", () => {
    const held = new Set([cusip(1), cusip(2), cusip(3), cusip(4)]);
    const events = positionEvents(now, before, held, new Map([[cusip(3), 3]]));
    expect(kinds(events).filter((k) => k.startsWith("add"))).toEqual(["add:2"]);
  });

  it("without the previous quarter's filing, knows only the best idea and top 3", () => {
    const older = filing("1", "2024Q4", [[1, 5e8, 100]]);
    expect(kinds(positionEvents(now, older, new Set([cusip(4)]), new Map()))).toEqual(["best:4", "top3:4", "top3:1", "top3:2"]);
    expect(kinds(positionEvents(now, undefined, new Set(), new Map()))).toEqual(["best:4", "top3:4", "top3:1", "top3:2"]);
  });

  it("records each event's weight and when it became public", () => {
    const [best] = positionEvents(now, before, new Set(), new Map());
    expect(best).toMatchObject({ kind: "best", cik: "1", period: "2025-06-30", filedOn: "2025-06-28", weight: 6e8 / 19e8 });
  });
});

describe("consensusEvents", () => {
  it("is public when the second manager's filing is, and counted once per name", () => {
    const held = new Set([cusip(7)]);
    const prev = (cik: string) => filing(cik, "2025Q1", [[1, 1e9]]);
    const e1 = positionEvents(filing("1", "2025Q2", [[7, 1e9], [1, 1e9]], "2025-08-01"), prev("1"), held, new Map());
    const e2 = positionEvents(filing("2", "2025Q2", [[7, 1e9], [1, 1e9]], "2025-08-14"), prev("2"), held, new Map());
    const e3 = positionEvents(filing("3", "2025Q2", [[7, 1e9], [1, 1e9]], "2025-08-10"), prev("3"), held, new Map());
    const consensus = consensusEvents([...e1, ...e2, ...e3]);
    expect(consensus).toHaveLength(1);
    expect(consensus[0]).toMatchObject({ kind: "consensus", cusip: cusip(7), cik: "3", filedOn: "2025-08-10", weight: 3 });
    expect(consensusEvents(e1)).toEqual([]);
  });
});

describe("shareRatios", () => {
  it("is each CUSIP's median share change among filers holding it both quarters", () => {
    const prev = ["1", "2", "3", "4", "5"].map((cik) => filing(cik, "2025Q1", [[1, 1e8, 100], [2, 1e8, 100]]));
    const now = ["1", "2", "3", "4", "5"].map((cik, i) => filing(cik, "2025Q2", [[1, 1e8, 200], ...(i < 4 ? [[2, 1e8, 100] as [number, number, number]] : [])]));
    const ratios = shareRatios(now, prev);
    expect(ratios.get(cusip(1))).toBe(2);
    expect(ratios.has(cusip(2))).toBe(false); // only four holders
  });
});

describe("parseFigi", () => {
  it("prefers the US composite and writes share classes as Alpaca does", () => {
    const r = parseFigi({ data: [{ ticker: "BRK/B", exchCode: "UN", marketSector: "Equity", securityType: "Common Stock", name: "BERKSHIRE" }, { ticker: "BRK/B", exchCode: "US", marketSector: "Equity", securityType: "Common Stock", securityType2: "Common Stock", name: "BERKSHIRE HATHAWAY INC-CL B" }] });
    expect(r).toEqual({ ticker: "BRK.B", excluded: false, name: "BERKSHIRE HATHAWAY INC-CL B" });
  });

  it("without a US composite row, takes the ticker most US exchanges carry", () => {
    const row = (ticker: string, exchCode: string) => ({ ticker, exchCode, marketSector: "Equity", securityType: "Common Stock", name: "EXXON MOBIL CORP" });
    expect(parseFigi({ data: [row("EXMOC", "CP"), row("XOM", "UZ"), row("XOM", "UN"), row("XOMQ", "UA")] }).ticker).toBe("XOM");
    expect(parseFigi({ data: [row("EXMOC", "CP"), row("EXMOC", "RC")] }).ticker).toBeNull(); // no US listing
  });

  it("excludes ETFs and funds, and reads a miss as unmapped", () => {
    expect(parseFigi({ data: [{ ticker: "VTI", exchCode: "US", marketSector: "Equity", securityType: "ETP", securityType2: "Mutual Fund" }] }).excluded).toBe(true);
    expect(parseFigi({ warning: "No identifier found." })).toEqual({ ticker: null, excluded: false, name: null });
  });
});

describe("windowLinks", () => {
  it("reads both naming schemes and orders the windows by their first day", () => {
    const html = `<a href="/files/structureddata/data/form-13f-data-sets/01jan2024-29feb2024_form13f.zip">x</a>
      <a href="/files/structureddata/data/form-13f-data-sets/2023q4_form13f.zip">y</a>
      <a href="/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip">z</a>
      <a href="/files/form_13f_readme.pdf">readme</a>`;
    expect(windowLinks(html).map((w) => [w.name, w.start])).toEqual([
      ["2023q4", "2023-10-01"],
      ["01jan2024-29feb2024", "2024-01-01"],
      ["01jun2026-31aug2026", "2026-06-01"],
    ]);
    expect(windowStart("readme")).toBeNull();
  });
});

describe("fails-to-deliver symbols", () => {
  // Real rows from SEC's cnsfails201806a (June 2018).
  const lines = [
    "SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE",
    "20180601|285512109|EA|3514|ELECTRONIC ARTS INC|130.91",
    "20180604|G5960L103|MDT|267|MEDTRONIC PLC ORD SHS (IRL)|87.83",
    "20180601|30303M102|FB|1200|FACEBOOK INC CL A COM STK (DE)|193.99",
    "20180601|084670702|BRKB|100|BERKSHIRE HATHWY INC(HLDG CO)B|187.40",
  ];

  it("keeps each CUSIP's latest symbol", () => {
    const latest = new Map();
    for (const l of lines) {
      const r = ftdRow(l);
      if (r) noteSymbol(latest, r);
    }
    noteSymbol(latest, { cusip: "30303M102", symbol: "META", date: "2023-01-03", description: "META PLATFORMS INC CL A" });
    noteSymbol(latest, { cusip: "30303M102", symbol: "FB", date: "2019-01-03", description: "FACEBOOK INC CL A" });
    expect(ftdRow(lines[0]!)).toBeNull();
    expect(latest.get("285512109")).toEqual({ symbol: "EA", date: "2018-06-01", description: "ELECTRONIC ARTS INC" });
    expect(latest.get("30303M102").symbol).toBe("META");
  });

  it("falls back to the fails data when OpenFIGI has no US listing", () => {
    const ea = { symbol: "EA", date: "2018-06-01", description: "ELECTRONIC ARTS INC" };
    expect(resolveTicker({ ticker: null, excluded: false, name: null }, ea)).toEqual({ ticker: "EA", excluded: false, source: "fails data" });
    expect(resolveTicker({ ticker: "XOM", excluded: false, name: "EXXON" }, ea)).toEqual({ ticker: "XOM", excluded: false, source: "openfigi" });
    expect(resolveTicker(undefined, { symbol: "BRKB", date: "2018-06-01", description: "BERKSHIRE HATHWY INC CL B" }).ticker).toBeNull();
    expect(resolveTicker(undefined, { symbol: "SPY", date: "2018-06-01", description: "SPDR S&P 500 ETF TRUST" }).excluded).toBe(true);
    expect(resolveTicker(undefined, undefined)).toEqual({ ticker: null, excluded: false, source: null });
  });

  it("lists the fails-data zips oldest first", () => {
    const html = '<a href="/files/data/fails-deliver-data/cnsfails202610b.zip">b</a><a href="/files/data/fails-deliver-data/cnsfails201801a.zip">a</a>';
    expect(ftdLinks(html).map((l) => l.name)).toEqual(["cnsfails201801a", "cnsfails202610b"]);
  });
});
