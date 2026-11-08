# Tasks: insider-buy backtest (#29)

> Plan: [insider-backtest-plan.md](insider-backtest-plan.md)
> **gate** = `npm run typecheck && npm test`. Focused: `npx vitest run insider` (in `packages/core`). One PR from `feat/insider-backtest`, cut from pulled `main`.

### B1: Purchases and events (pure)
- [ ] `parseDataSet(tables)`: SUBMISSION + REPORTINGOWNER + NONDERIV_TRANS rows (by header name) → purchases `{ accession, cik, ticker, filedAt, tradeDate, owner, roles, title, shares, price, dollars, plan10b5One: boolean | null }`
- [ ] Filters: code `P`, price > 0, a director, officer or 10% owner, not an amendment, not 10b5-1 when flagged
- [ ] `groupEvents(purchases)`: per issuer, filed within 30 days → `{ ticker, firstFiled, lastFiled, insiders, ceoOrCfo, dollars }`
- [ ] Tests: fixtures cut from a real quarter (an old one without the 10b5-1 column and a new one with it); multi-owner filings; a sale and an option exercise are ignored
- **Files:** `src/research/insider-backtest.ts`, `test/research/insider-backtest.test.ts`, fixtures · **Scope:** M

### B2: Returns and buckets (pure)
- [ ] `eventReturns(event, bars, vtiBars)`: entry at the first close after `lastFiled`; prior 60-day return; tradable at entry (price ≥ $5, 20-day ADV ≥ $10M); excess vs VTI at 20/60/120 trading days (null if the window isn't complete)
- [ ] `bucketStats(rows, key)`: n, mean, median, beat-VTI share, standard error, per horizon
- [ ] Tests: hand-computed returns, look-ahead (a filing after the close enters the next day), an untradable entry, an incomplete window
- **Depends on:** B1 · **Scope:** M

### B3: Fetch + cache script
- [ ] `scripts/research-insiders.ts`: download the zips (User-Agent, ≤ 5 req/s, skip if cached), unzip into one directory per zip, parse; fetch bars per ticker in batches, cached as JSON; resumable
- [ ] `.gitignore` gains `packages/core/.cache/`
- [ ] `--quarters 2025q1` for a single-quarter run
- **Depends on:** B2 · **Scope:** M

## Checkpoint A
- [ ] Gate green
- [ ] One quarter end to end; five events spot-checked against their Form 4s on sec.gov

### B4: Full run + report
- [ ] 2018q1–2026q2; `docs/research/insider-buys-vs-vti-2026-11.md`: the method, the biases (with counts dropped), bucket tables, year by year, and a plain-language summary of what it means for Trader
- **Depends on:** B3 · **Scope:** S

## Checkpoint B
- [ ] Scott reads the report

### B5: findings into the routine
- [ ] `agent/routine-prompt.md` states the findings (or the absence of an edge); merge → RemoteTrigger update
