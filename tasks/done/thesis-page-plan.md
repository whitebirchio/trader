# Plan: the thesis detail page (#39)

> **Status: Approved** (Scott, 2026-11-08: "let's tackle #39 next"). Small to medium; tasks inline. Read-only: no change to risk, targets, planning or orders.

## Why
The track record says how each thesis did against VTI. It doesn't show the story: what the price did against the cost basis and the stop, when the evidence was dated, and how Claude resized the thesis version by version. One page per thesis puts that in one place.

## What the page shows (`/theses/[id]`)
- **Header:** the symbol, the id chain, the primary evidence kind, and how the thesis ended (held, stopped out, went stale, removed, review date passed), with its days held.
- **Scorecard figures:** bought, return, the same dollars in VTI, and the gap (the track-record row), or why it isn't scored.
- **Price chart:** the daily close from 30 sessions before the thesis opened to its close (or now). It marks:
  - the average cost and, while held, the stop price (horizontal lines, direct-labeled);
  - each buy and sell (markers);
  - each evidence date (vertical guides).
  
  It has a crosshair tooltip and a table view.
- **Reasoning and evidence:** from the latest version that holds the thesis, with source links.
- **Version history:** each strategy version that holds it, with its weight, stop and review date, and what changed. It also shows the version that dropped it.
- **Events:** stops, staleness and overdue exits from `thesis_events`.

It links from the track record (the symbol), the strategy page (each thesis heading) and holdings (each conviction symbol).

## Design
- **The data gap:** the dashboard has no broker keys, and the database only records VTI's closes. A new table, **`thesis_closes`** (symbol, trading date, adjusted close), is filled after the close by `sync-broker`. It is the same best-effort step that records VTI (`recordBenchmarkCloses`): one bars request for every symbol any strategy version has held as a thesis, from 30 days before its first version. Re-reading the window keeps every close on one adjustment basis. The migration is **additive**, and the dashboard role's default `SELECT` grant covers the new table.
- **Adjusted closes vs fill prices:** the chart's closes are dividend- and split-adjusted; fills and cost are actual prices. Over a thesis's weeks they differ by at most a dividend, and the caption says so.
- **Core read model:** `thesisView(db, id, now)` in `dashboard/views.ts`. It is built from `loadScorecard` (each row now carries its window's fills), strategy versions, `thesis_events`, open lots (`averageCost`, as holdings computes the stop) and `thesis_closes`.
- **Chart:** recharts. It is one series in the validated `--portfolio` slot. The cost and stop lines are muted ink with dash patterns and direct labels. Fills are shape-coded markers (▲ buy, ▼ sell) with a surface ring. No new palette slots.

## Tasks
- [x] T1: `thesis_closes` migration + `recordThesisCloses` in `sync-broker` (tests)
- [x] T2: Scorecard rows carry fills; `thesisView` (tests: open thesis with stop, closed thesis, version history with weight change and removal, unknown id)
- [x] T3: `/theses/[id]` page + chart; links from track record, strategy and holdings
- [x] T4: SPEC-dashboard (pages table), gate, staging deploy; data checked on staging (the owner's look at the page is in `tasks/live-checks-todo.md`)
