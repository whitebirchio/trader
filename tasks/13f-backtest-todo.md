# Tasks: 13F best ideas and 13D/13G stakes vs VTI (#138)

> Plan: [13f-backtest-plan.md](13f-backtest-plan.md)
> **gate** = `npm run typecheck && npm test`. Focused tests run in `packages/core`. PR 1 from `feat/13f-backtest`; PR 2 from `feat/13d-backtest`, cut from pulled `main` after PR 1 merges.

## PR 1: 13F

### T1: 13F filings from data-set rows (pure)
- [x] `windowMeta(tables)` + `filingBuilder(keep)` (built as these two: the builder takes INFOTABLE a row at a time, so the script streams it): SUBMISSION, COVERPAGE, SUMMARYPAGE and INFOTABLE rows (by header name) → filings `{ accession, cik, manager, period, filedAt, amendment: null | "restatement" | "new holdings", positions }`. Each position is `{ cusip, issuer, titleOfClass, value, shares, shareType, putCall }`.
- [x] Values in dollars: ×1000 for filings before 2023-01-03.
- [x] Positions: drop `PUTCALL` rows and `PRN` rows; sum rows that share a CUSIP.
- [x] Tests:
  - fixtures cut from a real pre-2023 window and a 2025 window;
  - the unit change;
  - an options row and a PRN row dropped;
  - sub-manager rows summed;
  - an amendment kept apart.
- **Files:** `src/research/thirteen-f.ts`, `test/research/thirteen-f.test.ts`, fixtures · **Scope:** M

### T2: Manager set and events (pure)
- [x] `managerSet(history, period)`, point-in-time:
  - ≤ 30 positions and ≥ $1B in them;
  - ≥ 4 prior filings;
  - median consecutive prior filings per current position (capped at 8) ≥ 4;
  - related filers collapsed at 90%+ value overlap.
- [x] `positionEvents(previous, current)`: new position, large add (shares +25%), best idea, top 3, new in top 5.
- [x] `consensusEvents(events)`: 2+ managers in the set, new or added, same period, one event per name.
- [x] `ETF_TYPES` and `parseFigi(response)`: ticker and security type per CUSIP.
- [x] Tests:
  - a manager crossing 30 positions;
  - too few prior filings;
  - a high-turnover manager excluded;
  - a later filing doesn't change an earlier period's set (look-ahead);
  - each event type on hand-built filings;
  - related filers collapsed;
  - ETF rows dropped after mapping.
- **Depends on:** T1 · **Scope:** M

### T3: Shared stats (pure)
- [x] `outcomeAfter`/`outcomeAt` take an optional horizons list, defaulting to `HORIZONS`.
- [x] `cohortStats(rows, cohortOf, horizon)`: cohorts, mean of cohort means, standard error across cohorts, share of cohorts beating VTI.
- [x] `promotion({ inSample, heldOut }, roundTrip = 0.002)`: 60-day mean after costs > 0 in both, in-sample ≥ 2 SE, 120-day not reversed. Returns pass/fail and which test failed.
- [x] Tests:
  - hand-computed cohorts;
  - a 250-day horizon;
  - each promotion test failing on its own;
  - existing `insider-backtest` / `earnings-backtest` / `momentum` tests unchanged.
- **Files:** `src/research/backtest.ts`, `test/research/backtest.test.ts` · **Depends on:** none · **Scope:** S

### T4: `research:13f` script, one window end to end
- [x] `research-common.ts` gains `secGet(url)`:
  - User-Agent;
  - ≤ 5 requests a second;
  - cached on disk;
  - stops at the first 403/429 with a resume message.
- [x] `scripts/research-13f.ts`:
  - list and download the windows' zips;
  - stream the tables with `unzip -p`;
  - write compact per-window JSON;
  - map CUSIPs through OpenFIGI (cached; name-match fallback);
  - fetch bars;
  - print or write the tables (rule-based set, named list, quarter-end entry, year by year, skip counts);
  - flags: `--windows`, `--report` and `--prune`.
- [x] `package.json`: `research:13f`.
- **Depends on:** T2, T3 · **Scope:** M

## Checkpoint A
- [x] Gate green
- [x] End to end on the 2017q1–2018q4 windows (2026-11-20): the rule needs 4 prior filings, so one window alone has no manager set. About 113 concentrated managers a quarter, and 2,190 rule-based events scored from 2018 filings. Five events (one each of new, add, best, new in top 5, consensus: Fundsmith/PYPL, Soroban/CHTR, Trian/PG, Primavera/XNET, Brave Warrior/GOOGL) matched their information tables on sec.gov (shares, value, rank, held or not the quarter before).
- [x] Mapping, found on the run: OpenFIGI asked for exchange `US` missed even Exxon, and without the filter it often returns only foreign listings (EA, Medtronic, Chubb). Fixed by picking the US row from the unfiltered answer, and falling back to the CUSIP's latest symbol in SEC's fails-to-deliver data (210 half-month files from 2018, each deleted once read). Unmapped events fell from 930 to 276 (90 of 860 CUSIPs).
- [x] "New in top 5" counted positions in books of 3–4 names (Primavera's XNET was 0.9% of its book). Scott (2026-11-20): add a 5% minimum weight, decided before the full run was scored. Only the checkpoint's 2018 figures for that bucket had been seen.

### T5: Full run and report
- [x] Windows 2016q1 to the latest. `docs/research/13f-best-ideas-vs-vti-<date>.md` holds:
  - the method;
  - the biases, with counts dropped;
  - the bucket tables (event and cohort level), year by year, and in-sample vs held out;
  - the promotion verdict per bucket;
  - the lag cost (quarter-end vs filing entry);
  - a hand-written summary of what it means for Trader.
- [x] A row in `docs/research/README.md`.
- [x] 2026-11-20: 26,585 rule-based events scored; no bucket passes. The zips were pruned after the run (2.6 GB freed); the extracted filings (about 100 MB) stay until Part 2 is done, then `--clean`.
- **Depends on:** T4 · **Scope:** S

## Checkpoint B
- [x] Scott reads the report and decides how the routine treats `13f`. Scott (2026-11-23): like insider buying. A 13F can lead a thesis sized at 5–10%, with a second, independent kind of evidence, and only a big new position (new in a manager's top five at 5%+ of the book) counts.

### T6: The finding into the routine
- [x] `agent/routine-prompt.md` and the MCP server instructions state Scott's direction. `get_rules` unchanged: it's guidance, not a rule code enforces, and the other evidence directions aren't there either.
- [x] Docs: the plan ticked. SPEC-agent unchanged: it doesn't record the owner's evidence directions.
- [ ] Merge. The prompt ships on merge; RemoteTrigger only if the routine's stub text changes.
- **Depends on:** Checkpoint B · **Scope:** S

## PR 2: 13D/13G

### T7: Ownership filings from the index (pure)
- [x] `parseIndex(text)` → rows. `ownershipFilings(rows)` groups rows by accession into `{ accession, form: "13D" | "13G", amendment, filedAt, ciks }`. Both form-type families count (`SC 13D…` and, from Dec 2024, `SCHEDULE 13D…`).
- [x] `resolveParties(filing, thirteenFFilers)`: filer vs subject. When that's ambiguous, return `needs header`, and `parseHeader(text)` reads `SUBJECT COMPANY` / `FILED BY`.
- [x] `parseCoverXml` / `parseCoverText` (built as two):
  - percent of class, CUSIP and event date from the XML (Dec 2024 on);
  - from the text cover before that, the CUSIP (a US ISIN is read as one), plus best-effort percent, event date and the 13G-to-13D box.
- [x] Filters: initial filings only (`amendment` kept apart); the filer files 13F-HR, which rules out individuals such as the company's own insiders; a company filing on itself is `self`. A parent company that also files 13Fs isn't told apart yet: T8 counts how often a filer's name matches the subject's.
- [x] Tests:
  - fixtures from real index days (old and new form names);
  - a pair resolved without a header;
  - an ambiguous pair;
  - an amendment;
  - both cover formats.
- Found on the fixtures (2026-11-23): almost every filing is a pair of index rows. One 13F filer resolves it; both or one row goes to the header (`.hdr.sgml`, about 1.5 KB, which exists for older filings too); none drops it. Filings before Dec 2024 have no `index.json`, so their cover is the full submission (~50–80 KB): fetch it only when the subject's CIK doesn't map to a ticker.
- **Files:** `src/research/ownership-filings.ts`, `test/research/ownership-filings.test.ts`, fixtures · **Scope:** M

### T8: `research:13d` script, one quarter end to end
- [x] `scripts/research-13d.ts`:
  - daily indexes (cached);
  - headers and covers only where needed;
  - subject → ticker via `company_tickers.json`, with the cover's CUSIP through OpenFIGI as the fallback;
  - the concentrated flag from T5's per-period manager sets;
  - bars;
  - tables: 13D/13G × concentrated or not, stake size, prior 60 days, filing lag before and after Feb 2024, year by year, skip counts.
- [x] `package.json`: `research:13d`.
- [x] Shared with research:13f in `scripts/research-tables.ts`: the tables and OpenFIGI mapping (13F report rerun unchanged, byte for byte). `secFetch` keeps 5 a second across parallel workers and stops them all at a refusal.
- [x] Found on the first quarter (2019 Q1, 31 minutes serial): most time went to SEC requests, a third of them headers sent by an issuer check that the cover already covers. Dropped that check; headers now only when both parties file 13Fs or the index lists one (97 in 2022 Q1). With 6 parallel workers a heavy quarter takes about 12 minutes (2022 Q1: 2,001 covers in 7 minutes, then OpenFIGI).
- **Depends on:** T7, PR 1 merged · **Scope:** M

## Checkpoint C
- [x] Gate green
- [x] One quarter end to end (2019 Q1, 2026-11-23): 19,173 filings, 4,584 initial, 3,354 kept, 1,126 scored. Five spot-checked on sec.gov, one per bucket plus a delisted company mapped through the fails data: Silver Lake/Dell 13D (44.3%, the group's combined row), Goldman/EnLink 13D (12.3%), Resolution Capital/Empire State Realty 13G (5.27%), Kayne Anderson Rudnick/U.S. Physical Therapy 13G (stake not fetched by design: 10.98% on sec.gov), JPMorgan/Catalent 13G (5.6%). Filer, company, form, date and CUSIP → ticker all matched.

### T9: Full run and report
- [ ] 2018 to the latest. `docs/research/13d-13g-stakes-vs-vti-<date>.md`, in the same shape as T5's report, plus the filing-lag table. A row in the research README.
- **Depends on:** T8 · **Scope:** S

## Checkpoint D
- [ ] Scott reads the report.

### T10: The finding into the routine
- [ ] As T6, for 13D/13G. Then merge, and close #138.
- **Depends on:** Checkpoint D · **Scope:** S
