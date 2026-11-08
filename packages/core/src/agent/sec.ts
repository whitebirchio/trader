import { type EarningsRelease, type FilingColumns, earningsReleases } from "../research/earnings-backtest.js";

/**
 * Read-only access to SEC EDGAR for check_eligibility's earnings screen
 * (#54): a company's earnings releases (8-K item 2.02) from its submissions
 * index. Fail-soft: null when SEC can't be read, so the tool reports the gap
 * instead of failing.
 */
export interface FilingsPort {
  /** Earnings releases, oldest first; [] for a symbol SEC doesn't list (an ETF, say); null if SEC couldn't be read. */
  earningsReleases(symbol: string): Promise<EarningsRelease[] | null>;
}

/** SEC asks automated clients to identify themselves as "name email"; data.sec.gov refuses others. */
export const SEC_USER_AGENT = "Scott Schmalz scott.schmalz@gmail.com";

export class SecFilings implements FilingsPort {
  private tickers: Promise<Map<string, string>> | null = null;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly userAgent = SEC_USER_AGENT,
    private readonly timeoutMs = 10_000,
  ) {}

  private async json(url: string): Promise<unknown | null> {
    const res = await this.fetchFn(url, { headers: { "user-agent": this.userAgent, "accept-encoding": "gzip" }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  /** SEC's ticker → CIK map (in Alpaca's form, BRK-B → BRK.B), loaded once per process. */
  private cikMap(): Promise<Map<string, string>> {
    this.tickers ??= this.json("https://www.sec.gov/files/company_tickers.json")
      .then((doc) => {
        const m = new Map<string, string>();
        for (const r of Object.values((doc ?? {}) as Record<string, { cik_str: number; ticker: string }>)) {
          const t = r.ticker.toUpperCase().replace("-", ".");
          if (!m.has(t)) m.set(t, String(r.cik_str).padStart(10, "0"));
        }
        return m;
      })
      .catch((e: unknown) => {
        this.tickers = null; // try again next call
        throw e;
      });
    return this.tickers;
  }

  async earningsReleases(symbol: string): Promise<EarningsRelease[] | null> {
    try {
      const cik = (await this.cikMap()).get(symbol);
      if (!cik) return [];
      const doc = (await this.json(`https://data.sec.gov/submissions/CIK${cik}.json`)) as { filings?: { recent?: FilingColumns } } | null;
      return doc?.filings?.recent ? earningsReleases(doc.filings.recent) : [];
    } catch {
      return null;
    }
  }
}
