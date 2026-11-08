# Plan: the exposure tool (#31)

> **Status: Approved** (Scott, 2026-11-08: "let's do #31"). Small; tasks inline. Read-only and informational: risk doesn't use it.

## Why
The routine works out concentration by hand in its summaries ("industrials ~26%"), and its prompt already asks it to keep any one sector under about 40% and to treat two theses in one industry as one bet. `get_exposure` gives it the numbers.

## Design
- **Industry:** SEC's SIC code and description, from the same submissions index `check_eligibility` already reads (`FilingsPort.industry`). It maps to an approximate GICS-style sector by SIC range (`sicSector`). SIC predates GICS, so a few companies land differently from a data vendor's sector, and the SEC description is reported beside it. VTI is the broad market; the Select Sector SPDRs (XLB…XLY) take the sector they track, since funds have no SIC code.
- **Correlation:** Pearson correlation of daily returns over the last 60 sessions, among single names (VTI is reported separately as each name's correlation with the market). It lists pairs at 0.5 or more, and `oneBet` at 0.7 or more. A pair with fewer than 40 common sessions isn't measured.
- **Scope:** holdings, plus active theses not bought yet, plus up to 25 `symbols` the routine passes, so a draft can be checked before it's submitted.
- **Fail-soft:** SEC unreadable → the sector is Unclassified, with a note; too little price history → a note.

## Tasks
- [x] E1: `FilingsPort.industry` + `SecFilings` (tests)
- [x] E2: `agent/exposure.ts` (`sicSector`, `dailyReturns`, `correlation`, `exposureReport`) + `getExposure` (tests)
- [x] E3: MCP tool, pinned list, instructions, SPEC-agent, routine prompt
- [x] E4: Gate; staging deploy; run it on staging data; after merge, update the routine (RemoteTrigger, 2026-11-08)
