import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SecFilings } from "../../src/agent/sec.js";

// Trimmed real submissions JSON for LKQ (from the earnings backtest's fixtures).
const lkq = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "research", "fixtures", "submissions-lkq.json"), "utf8");
const TICKERS = JSON.stringify({ 0: { cik_str: 1065696, ticker: "LKQ", title: "LKQ CORP" }, 1: { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY" } });

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    expect((init?.headers as Record<string, string>)["user-agent"]).toMatch(/^\S+ \S+ \S+@\S+$/); // SEC's "name email"
    const route = Object.entries(routes).find(([k]) => u.includes(k));
    return route ? route[1]() : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("SecFilings", () => {
  it("finds a company's earnings releases by ticker, loading the ticker map once", async () => {
    const { fn, calls } = fakeFetch({ company_tickers: () => new Response(TICKERS), CIK0001065696: () => new Response(lkq) });
    const sec = new SecFilings(fn);
    expect((await sec.earningsReleases("LKQ"))?.map((r) => r.filedOn)).toEqual(["2026-10-23", "2026-10-29"]);
    await sec.earningsReleases("LKQ");
    expect(calls.filter((c) => c.includes("company_tickers"))).toHaveLength(1);
  });

  it("maps SEC's BRK-B to Alpaca's BRK.B, and returns [] for a symbol SEC doesn't list or a missing index", async () => {
    const { fn, calls } = fakeFetch({ company_tickers: () => new Response(TICKERS) });
    const sec = new SecFilings(fn);
    expect(await sec.earningsReleases("BRK.B")).toEqual([]); // the submissions file 404s
    expect(calls.at(-1)).toContain("CIK0001067983");
    expect(await sec.earningsReleases("VTI")).toEqual([]);
  });

  it("reads a company's SIC industry from the same index; nulls for a symbol SEC doesn't list, null when SEC can't be read", async () => {
    const withSic = JSON.stringify({ ...JSON.parse(lkq), sic: "5013", sicDescription: "WHOLESALE-MOTOR VEHICLE SUPPLIES & NEW PARTS" });
    const sec = new SecFilings(fakeFetch({ company_tickers: () => new Response(TICKERS), CIK0001065696: () => new Response(withSic) }).fn);
    expect(await sec.industry("LKQ")).toEqual({ sic: "5013", description: "WHOLESALE-MOTOR VEHICLE SUPPLIES & NEW PARTS" });
    expect(await sec.industry("VTI")).toEqual({ sic: null, description: null });
    const down = new SecFilings(fakeFetch({ company_tickers: () => new Response("", { status: 503 }) }).fn);
    expect(await down.industry("LKQ")).toBeNull();
  });

  it("lists a company's recent filings with their items and documents, and reads a document; both throw when SEC can't be read (#105)", async () => {
    const { fn } = fakeFetch({ company_tickers: () => new Response(TICKERS), CIK0001065696: () => new Response(lkq), "000106569626000058": () => new Response("<p>8-K</p>") });
    const sec = new SecFilings(fn);
    const recent = await sec.recentFilings("LKQ");
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0]).toMatchObject({ cik: "0001065696", accession: expect.stringMatching(/^\d{10}-\d{2}-\d{6}$/), filedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(recent.find((f) => f.form === "8-K")?.items.length).toBeGreaterThan(0);
    expect(await sec.recentFilings("VTI")).toEqual([]);
    expect(await sec.document("https://www.sec.gov/Archives/edgar/data/1065696/000106569626000058/lkq-20261109.htm")).toBe("<p>8-K</p>");
    await expect(sec.document("https://www.sec.gov/missing.htm")).rejects.toThrow("HTTP 404");
    const down = new SecFilings(fakeFetch({ company_tickers: () => new Response(TICKERS), CIK0001065696: () => new Response("", { status: 503 }) }).fn);
    await expect(down.recentFilings("LKQ")).rejects.toThrow("HTTP 503");
  });

  it("is null when SEC can't be read, and tries the ticker map again next time", async () => {
    let fail = true;
    const { fn } = fakeFetch({ company_tickers: () => (fail ? new Response("", { status: 503 }) : new Response(TICKERS)), CIK0001065696: () => new Response(lkq) });
    const sec = new SecFilings(fn);
    expect(await sec.earningsReleases("LKQ")).toBeNull();
    fail = false;
    expect(await sec.earningsReleases("LKQ")).toHaveLength(2);
  });
});
