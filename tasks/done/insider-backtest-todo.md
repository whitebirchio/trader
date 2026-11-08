# Tasks: insider-buy backtest (#29)

> Plan: [insider-backtest-plan.md](insider-backtest-plan.md)
> **gate** = `npm run typecheck && npm test`. Focused: `npx vitest run insider` (in `packages/core`). One PR from `feat/insider-backtest`, cut from pulled `main`.

### B1: Purchases and events (pure)
- [x] `parseDataSet(tables)`: SUBMISSION + REPORTINGOWNER + NONDERIV_TRANS rows (by header name) → purchases `{ accession, cik, ticker, filedAt, tradeDate, owner, roles, title, shares, price, dollars, plan10b5One: boolean | null }`
- [x] Filters: code `P`, price > 0, a director, officer or 10% owner, not an amendment, not 10b5-1 when flagged
- [x] `groupEvents(purchases)`: per issuer, filed within 30 days → `{ ticker, firstFiled, lastFiled, insiders, ceoOrCfo, dollars }`
- [x] Tests: fixtures cut from a real quarter (an old one without the 10b5-1 column and a new one with it); multi-owner filings; a sale and an option exercise are ignored
- **Files:** `src/research/insider-backtest.ts`, `test/research/insider-backtest.test.ts`, fixtures · **Scope:** M

### B2: Returns and buckets (pure)
- [x] `eventReturns(event, bars, vtiBars)`: entry at the first close after `lastFiled`; prior 60-day return; tradable at entry (price ≥ $5, 20-day ADV ≥ $10M); excess vs VTI at 20/60/120 trading days (null if the window isn't complete)
- [x] `bucketStats(rows, key)`: n, mean, median, beat-VTI share, standard error, per horizon
- [x] Tests: hand-computed returns, look-ahead (a filing after the close enters the next day), an untradable entry, an incomplete window
- **Depends on:** B1 · **Scope:** M

### B3: Fetch + cache script
- [x] `scripts/research-insiders.ts`: download the zips (User-Agent, ≤ 5 req/s, skip if cached), unzip into one directory per zip, parse; fetch bars per ticker in batches, cached as JSON; resumable
- [x] `.gitignore` gains `packages/core/.cache/`
- [x] `--quarters 2025q1` for a single-quarter run
- **Depends on:** B2 · **Scope:** M

## Checkpoint A
- [x] Gate green
- [x] One quarter end to end (2025q4: 2,901 purchases → 1,209 events, 399 scored); five events spot-checked against their Form 4 XML on sec.gov, all matching (ticker, owner, filing date, shares × price, not 10b5-1)
- [x] Found on the spot check: same-day director buys on a schedule (SPG's ten directors) inflate clusters → routine/opportunistic classification added (Cohen, Malloy & Pomorski 2012), with its own breakdowns from 2020

### B4: Full run + report
- [x] 2018q1–2026q2; `docs/research/insider-buys-vs-vti-2026-11.md`: the method, the biases (with counts dropped), bucket tables, year by year, and a plain-language summary of what it means for Trader (2026-11-08: 118,563 purchases → 43,609 events → 11,294 scored; the summary survives a re-run)
- **Depends on:** B3 · **Scope:** S

## Checkpoint B
- [x] Scott reads the report (2026-11-08): insider buying becomes weak supporting evidence; mix signals; review insider-dip theses by about three months

### B5: findings into the routine
- [x] `agent/routine-prompt.md` and the MCP server instructions state the owner's direction
- [x] Merge (#45) → RemoteTrigger update of the routine (2026-11-08)
