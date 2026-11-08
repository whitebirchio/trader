# Plan: chart time ranges (#59)

> **Status: Approved** (Scott, 2026-11-08: "let's start #59"). Small; tasks inline. Dashboard only, plus a longer price window in `sync-broker`'s best-effort thesis-closes step.

## Design
- **Ranges:**
  - Overview: 4 weeks · 3 months · 6 months · YTD · 1 year · Since start (default).
  - Thesis: 4 weeks · 3 months · 6 months · 1 year · Since first held (default).
- **Base:** the last data point on or before the range's start date. Both lines are rebased to 100 there, and the range's figures come from the same `compareToBenchmark` the digest uses. The Overview's "vs VTI" tile stays since start.
- **Availability:** a range the history doesn't reach is disabled, showing the date the history starts. Asking for it (`?range=`) falls back to the default, and a bad value falls back quietly.
- **Links:** server-rendered (`?range=…`), so a range can be bookmarked and needs no client code.
- **Data:** thesis closes are kept from 380 days before a symbol's first thesis, up from 30. The next after-close sync backfills them, because the step re-reads its whole window.
- **Markers:** fills and evidence dates before the range aren't drawn.

## Tasks
- [x] R1: `dashboard/ranges.ts` (`rangeFrom`, `windowBase`, `rangeOptions`, `parseRange`) + tests
- [x] R2: `performanceSeries` / `overviewView` and `thesisView` take a range; `CLOSES_LEAD_DAYS` 380 (tests)
- [x] R3: `RangePicker` + both pages; SPEC-dashboard
- [x] R4: Gate; staging deploy; backfilled staging closes (530); checked both pages in Chrome (2026-11-08), which caught the clipped labels and uneven axis
