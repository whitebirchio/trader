# Implementation Plan: 13F best ideas and 13D/13G stakes vs VTI (#138)

> Tasks are in [13f-backtest-todo.md](13f-backtest-todo.md).
> **Status: Approved** (Scott, 2026-11-20): the 2.5 GB download is fine, kept on disk (streamed, never held in memory) and deleted once no longer needed; Part 1 starts now; the named list stays Berkshire and Pershing. Two PRs, in order: Part 1 (13F), then Part 2 (13D/13G).

## Why

Theses can now name `13f` as their lead signal, but nothing in `docs/research/` has tested it. The live track record has too few 13F theses, held too briefly, to judge. A 13F is also late: it shows holdings at quarter-end and is filed up to 45 days after. This study answers two questions on past data, as the insider and earnings studies did:

1. **Does following concentrated managers' 13F moves beat VTI,** entering when the filing is public?
2. **Does an earlier ownership filing carry the same signal sooner?** A Schedule 13D is due within 5 business days of a manager crossing 5% (10 days before Feb 2024); a 13G is the passive version.

## What it is, and how it reaches decisions

It's an **offline research tool**, like `research:insiders`. Nothing runs on a schedule, trades, or touches a database. The output is two dated reports in `docs/research/`. They reach Trader's decisions after Scott reads them:

- **A bucket passes the promotion rule:** that signal stays (or becomes) a lead signal, sized like any other. A later issue could have a tick job surface fresh events to the routine.
- **Nothing passes:** the routine prompt and `get_rules` treat it as supporting evidence only, as with insider buys.

Either way, the routine prompt and the MCP server instructions state the finding (tasks T6 and T10).

## Data

All free, with no Alpha Vantage requests.

- **13F holdings:** SEC's [Form 13F Data Sets](https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets). These are zips of tab-separated tables from every 13F (SUBMISSION, COVERPAGE, SUMMARYPAGE, INFOTABLE, OTHERMANAGER). Their documentation is `/files/form_13f_readme.pdf`.
  - **Windows:** calendar quarters through 2023 (`2016q1_form13f.zip` …), then three-month filing windows (`01jun2026-31aug2026_form13f.zip`). The latest window ends Aug 2026, so the Nov 2026 filings aren't in this study.
  - **Download:** 2016q1 on, so that 2018's manager set has 8 quarters of history. That's **43 zips, about 2.5 GB**. They go in the git-ignored `packages/core/.cache/edgar13f/`.
  - **Extraction:** `unzip -p` streams the tables. The script keeps a compact JSON of the filings it needs for each window. It never writes the full INFOTABLE (millions of rows a window) to disk unpacked.
- **CUSIP → ticker:** 13Fs list securities by CUSIP. Map them with OpenFIGI's free mapping API (no key at low volume), cached per CUSIP. Its security type also identifies ETFs, which are dropped. The unmapped count is reported.
  - *(Changed at Checkpoint A.)* OpenFIGI often returns only a CUSIP's foreign listings, so the fallback is the CUSIP's latest symbol in SEC's fails-to-deliver data (one zip per half-month from 2018, each streamed and deleted), not name matching.
  - A symbol whose bars start more than 7 days after the filing is skipped as `stale bars`: a later listing under a reused ticker.
- **13D/13G filings:** EDGAR's daily `master.YYYYMMDD.idx` files for 2018 on, cached.
  - **Pairing (checked 2026-11-20 on one day's index):** each filing is listed once per entity it names, so the filer and the company it's about share an accession number.
  - **Form types:** `SC 13D`, `SC 13G` and their `/A` amendments; from Dec 2024, `SCHEDULE 13D`, `SCHEDULE 13G`, `/A`.
  - **Headers:** a filing's header (`SUBJECT COMPANY` / `FILED BY`) is fetched only when pairing can't tell the two apart.
  - **Cover pages:** fetched only for kept filings: XML from Dec 2024 (percent of class, CUSIP, event date), and the text cover's CUSIP before that.
- **Prices:** Alpaca's adjusted daily bars (`barsFor` in `research-common.ts`, paper keys), cached. VTI is the benchmark, as everywhere else.
- **SEC fair access:**
  - the declared User-Agent (`SEC_USER_AGENT`);
  - at most 5 requests a second;
  - everything cached, and a run can resume where it stopped;
  - the script stops at the first 403 or 429 and says how to resume, as `check-filings` does since #135.
  - SEC contents are parsed as text, never executed.

## Method

The rules below are fixed now, before any results.

### Part 1: 13F

- **Positions:** original `13F-HR` filings only, one per manager per period. Amendments are counted and reported, not scored.
  - Dropped: option rows (`PUTCALL`), principal-amount rows (`SSHPRNAMTTYPE = PRN`) and ETFs.
  - Rows for the same CUSIP are summed (filings split holdings across sub-managers).
  - Values are in thousands before 2023-01-03 and in dollars after. The parser converts by filing date.
- **Concentrated managers** are judged point-in-time each period, using only that manager's filings up to it:
  - at most 30 long positions;
  - at least $1B in them;
  - at least 4 prior filings;
  - low turnover: across current positions, the median number of consecutive prior filings a position appears in (capped at 8) is 4 or more.
  - Related filers (several CIKs, one group) are collapsed when two filings' holdings overlap 90% or more by value.
- **Events** per manager and period:

  | Bucket | Definition |
  |---|---|
  | New position | absent from the manager's previous filing |
  | Large add | shares up 25% or more |
  | Best idea | the manager's largest position by value |
  | Top 3 | one of the manager's three largest |
  | New in top 5 | a new position that is in their top 5 and at least 5% of the book *(the 5% floor added by Scott at Checkpoint A, before the full run was scored)* |
  | Consensus | newly bought or added by 2+ managers in the set in the same period (counted once) |

- **Named list:** Berkshire Hathaway and Pershing Square, scored beside the rule-based set. It's labelled hindsight-biased (we know those names because they did well) and can't be promoted.

### Part 2: 13D and 13G

- **Filings:** initial filings only. Amendments are reported as "adds", not scored.
- **Filers:** kept only if the filer also files `13F-HR` (an investment manager). Dropped: filings by the subject company's own officers, directors or parent company, an insider signal already tested.
- **Buckets:** 13D vs 13G, each split by whether the filer passes Part 1's concentrated-manager rule in its latest period. Descriptive breakdowns: stake 5–10% vs 10%+ (structured from Dec 2024, best effort before), and the prior-60-day return (down 20%+ or not).
- **Lag:** days from the event date (the crossing) to filing, reported before and after Feb 5, 2024.

### Shared

- **No look-ahead:** entry is the first close after the filing date, through `outcomeAfter`.
  - Part 1 also reports a **quarter-end entry** (the first close after the period end). It's untradable, so it's never promoted. It measures what the lag costs.
- **Universe:** risk's price and liquidity filters at entry (`TRADABILITY`).
- **Outcome:** the stock's return minus VTI's over 20, 60, 120 and 250 trading days.
- **Unit of inference is the cohort, not the event.** Filings cluster (four 13F seasons a year), and one name can be bought by several managers.
  - Part 1's cohort is the filing period. Part 2's is the filing month.
  - Statistics are the mean of cohort means and its standard error across cohorts. Event-level tables are shown too.
  - Windows of 120 and 250 days overlap across quarterly cohorts, so their standard errors are flagged as understated.
- **In-sample:** filings from 2018 to 2023. **Held out:** 2024 to the latest complete data.
  - Held-out results are computed, but read only to confirm an in-sample choice, as in `momentum.ts`.
  - Part 2's held-out period falls after the deadline change, so it's partly a new regime.
- **Promotion rule.** A bucket passes only if all three hold:
  1. its 60-day mean excess beats VTI after a 0.2% round trip, both in-sample and held out;
  2. the in-sample cohort mean is at least 2 standard errors above zero;
  3. the 120-day mean doesn't reverse it.

  Only the buckets above are scored. Nothing is searched for a pattern that happens to work.

## Code layout

- **`src/research/backtest.ts`** (shared):
  - `outcomeAfter`/`outcomeAt` gain an optional horizons list. The default stays `HORIZONS`, so the earlier studies' output doesn't change.
  - New `cohortStats(rows, cohortOf, horizon)`.
  - New `promotion(inSample, heldOut)` applies the rule above.
- **`src/research/thirteen-f.ts`** (pure):
  - parse data-set rows by header name → filings and positions;
  - `managerSet(history, period)`;
  - `positionEvents(previous, current)`;
  - `consensusEvents`;
  - parse OpenFIGI's mapping response.
- **`src/research/ownership-filings.ts`** (pure):
  - parse index rows and group them by accession;
  - resolve filer vs subject;
  - parse filing headers;
  - parse cover pages (XML, and the text cover's CUSIP).
- **Scripts:**
  - `scripts/research-13f.ts` (`npm run research:13f -w @trader/core -- [--windows …] [--report …]`);
  - `scripts/research-13d.ts` (`research:13d`, with `[--from YYYY-MM] [--report …]`).
  - Shared SEC fetching (rate limit, cache, stop at refusal) moves into `research-common.ts`.
- **Reports:** `docs/research/13f-best-ideas-vs-vti-<date>.md` and `docs/research/13d-13g-stakes-vs-vti-<date>.md`, each with a hand-written summary over regenerated tables, and a row in `docs/research/README.md`. That's two files rather than the one the issue names, because each script regenerates its own tables.

## Task list (detail in the todo)

**PR 1: 13F** (`feat/13f-backtest`)
- [ ] T1: 13F filings from data-set rows (pure, fixtures cut from a pre-2023 and a 2025 window)
- [ ] T2: Manager set and events (pure, point-in-time)
- [ ] T3: Shared stats: horizons, cohort statistics, the promotion rule
- [ ] T4: `research:13f` script, one window end to end
- **Checkpoint A:** one window's events spot-checked against filings on sec.gov
- [ ] T5: Full run and report
- **Checkpoint B:** Scott reads the report
- [ ] T6: The finding into the routine prompt and MCP instructions; merge

**PR 2: 13D/13G** (`feat/13d-backtest`, cut from main after PR 1 merges)
- [ ] T7: Ownership filings from the index (pure)
- [ ] T8: `research:13d` script, one quarter end to end
- **Checkpoint C:** spot check against sec.gov
- [ ] T9: Full run and report
- **Checkpoint D:** Scott reads the report
- [ ] T10: The finding into the routine prompt; merge

## Verification

- **The gate** (`npm run typecheck && npm test`) before every commit. Focused tests in `packages/core`: `npx vitest run thirteen-f`, `npx vitest run ownership`, `npx vitest run backtest`.
- **The earlier studies' tests still pass unchanged** (the default horizons).
- **Spot checks:** five events per checkpoint against the filings on sec.gov (manager, period, shares, value, new or added), plus the CUSIP → ticker mapping for each.
- **No paper rehearsal:** nothing in `src/broker/`, `src/risk/`, `rebalance.ts` or the order intents changes. Merging changes only the routine prompt and MCP instructions (T6, T10).
- **Public repo:** the reports hold only historical market data and simulated results, never account figures or holdings.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The data sets' columns or units differ across years (value units changed in 2023; windows renamed in 2024) | Med | Parse by header name; convert units by filing date; fixtures from both eras |
| CUSIPs that don't map (delisted, renamed, foreign) | High: like survivorship, it flatters results | Count and report unmapped and no-bars events; read every figure as a best case |
| OpenFIGI limits without a key | Low | Only the set's CUSIPs (a few thousand), cached; if a key is needed, Scott creates one (free) |
| Overlapping events (13F seasons, shared names) overstate significance | High | Cohort-level statistics; year-by-year tables; 120/250-day standard errors flagged |
| The named list carries hindsight | Med | Reported only, never promoted |
| Related filers double-count consensus | Med | Collapse filings that overlap 90%+ |
| SEC refuses requests mid-run | Low | Cached and resumable; stop at the first refusal |
| Six buckets per part invite a lucky pass | Med | The 2-standard-error bar in-sample, plus held-out confirmation |
| Disk: 2.5 GB of zips | Low | Git-ignored cache; compact JSON per window; `--prune` deletes the zips once extracted |

## Not changing

The engine, risk limits, sizing and the order path. Nothing is deployed but the prompt and MCP-instruction text in T6 and T10, and that only after Scott reads each report.

## Open questions

1. **Download:** is 2.5 GB of 13F zips in the local cache fine? Pruned after extraction, it's a few hundred MB. Or should T5 start in 2019 (a shorter in-sample period)?
2. **Named list:** just Berkshire and Pershing, or add a few more you'd like seen (reported only, never promoted)?
3. **Order:** run Part 1 now (it doesn't depend on the PEAD backtest, #105), or wait until #105 is done in early December?
