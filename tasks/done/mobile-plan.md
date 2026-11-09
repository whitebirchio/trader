# Plan: the dashboard on phones (SPEC-dashboard Amendment 2)

> **Status: Done** (2026-11-08, #66 and #67). Spec: SPEC-dashboard.md § Amendment 2 (approved). One branch (`feat/mobile-ux`) and one PR, with a commit per task. Presentation only: no read model, write path, auth or header changes.

## Approach
Measure first, then fix what the measurements show. The page-wide sideways scroll is most likely the menu, so the app shell goes first. Then tables, most-used pages first, then charts. Each task ends with `mobile:check` and a look at its iPhone 15 screenshots.

## Tasks

### M1: `mobile:check` (Playwright, iPhone 15) ✅
**Baseline (2026-11-08, iPhone 15 in dark mode, 393 × 659 visible):**
- 10 of 11 pages fail; `/login` passes.
- **Every signed-in page scrolls sideways:** the menu is 462 px wide ("Track record" wraps, "Activity" hangs off the edge).
- **Tables scroll inside their cards:** 384–704 px wide (Holdings ×2, Money, Track record ×2, Activity, thesis version history).
- **Small tap targets:** "Sign out" (16 px tall), the range buttons (26 px), "Table view" (16 px), "Cancel withdrawal…" (34 px).
- **A console error on /holdings:** a duplicate React key in the wash-sale list, from three partial sales of one symbol at the same time. Fix in M3.
- **Desktop at 1280 px:** clean apart from that console error.

**What:** a Playwright script (new dev dependency, `apps/dashboard`) that starts `next dev` against staging's read-only data with the dev sign-in bypass. Secrets come from SSM, as `docs/SETUP.md`'s local mode describes. It visits every page at 393 × 852 (iPhone 15 profile) and at 1280 × 800, and reports:
- sideways scroll;
- tap targets under 44 px;
- text inputs under 16 px.

Screenshots go to `apps/dashboard/.mobile/` (git-ignored).

**Done when:** it runs with one command and prints a per-page pass/fail; the first run records today's failures as the baseline.
**Files:** `apps/dashboard/package.json`, `apps/dashboard/scripts/mobile-check.ts`, `.gitignore`

### M2: The app shell ✅
**Result:** no page scrolls sideways at 393 px; the menu, refresh and Sign out pass the 44 px check; the desktop is unchanged apart from the current-page highlight and a refresh icon. Two departures from the plan:
- **No `overflow-x: clip` backstop:** it would hide real overflow from `mobile:check`.
- **The status bar stays `default`:** `black-translucent` would hide the status bar text in light mode. Check it on the phone.

**What:**
- the menu as one row that scrolls inside itself on phones (cut-off next item, faded edge, current page scrolled into view), with `aria-current` on every screen size;
- "Sign out" at the foot of the page on phones;
- safe-area padding at the top and bottom;
- `black-translucent` status bar;
- a refresh control, plus a refresh when the app returns to the foreground after more than a minute;
- a backstop so a stray wide element can't scroll the page (`overflow-x: clip` on the shell), alongside fixing the real cause.

**Done when:** `mobile:check` shows no sideways scroll caused by the shell on any page; the menu's tap targets are 44 px or more; the desktop screenshots are unchanged apart from the highlight.
**Files:** `src/app/(signed-in)/layout.tsx`, `src/app/layout.tsx`, `src/components/nav.tsx` (client: active page, scroll into view, refresh), `src/app/globals.css`

### Checkpoint 1
- [x] Gate green; `mobile:check` shows the shell fixed; pushed to staging so Scott could try the menu early

### M3: Cards for Holdings and Track record ✅
**Result:** both pages pass `mobile:check` on phone and desktop. Holdings fits every figure in three lines per row, so nothing needs to expand. The duplicate wash-sale key is fixed. The shared `TableOnWide` / `RowsOnPhone` / `PhoneRow` components carry the pattern to M4.

**What:** below 640 px, each row becomes a card:
- **Holdings:** symbol, value, weight vs target, gain, distance to stop; the rest expands in place.
- **Track record:** by-kind rows; theses with symbol, how it ended, return and vs VTI, linking to the thesis page.

Tables stay at 640 px and up.
**Done when:** no table scrolls sideways at 393 px on either page; each figure is shown or one tap away.
**Files:** `src/components/holdings-table.tsx`, `src/app/(signed-in)/track-record/page.tsx`, `src/components/ui.tsx` (a shared card or disclosure)

### M4: Cards for Activity, Money and thesis version history; inputs ✅
**Result:** Activity's orders, Money's transfers and the thesis version history are rows on phones; the Activity period links and the withdrawal buttons are 44 px; the withdrawal amount is `text-base` (16 px). Staging has a withdrawal open, so the amount field isn't on screen there for `mobile:check` to measure.

**What:** the same pattern for the activity timeline, the Money page's ledger and commands, and the thesis page's version history. Text inputs at 16 px. "Table view" toggles at 44 px.
**Done when:** `mobile:check` passes the table and input checks on every page.
**Files:** `src/app/(signed-in)/activity/page.tsx`, `src/app/(signed-in)/money/page.tsx`, `src/app/(signed-in)/theses/[id]/page.tsx`

### M5: Charts on phones ✅
**Result:** `mobile:check` is clear on every page at 393 px and 1280 px, and now also checks that charts have 280+ px of plot. On phones: short axis dates ("Nov 2", or "Nov '25" on long ranges); the thesis chart's cost and stop labels inside the plot; the Overview chart relies on its legend instead of end labels; range buttons and "Table view" at 44 px; cards a little tighter (p-3) so the plots fit.

**What:**
- short date labels ("Nov 2") and fewer ticks below 640 px;
- direct labels that fit (the thesis chart's right margin shrinks on phones, with the cost and stop labels drawn inside the plot);
- tap-to-inspect tooltips;
- range picker buttons with 44 px tap targets that wrap.

A unit test covers the short date formatter.
**Done when:** both charts have at least 280 px of plot at 393 px; `mobile:check` passes on the Overview and on thesis pages in every range.
**Files:** `src/components/performance-chart.tsx`, `src/components/thesis-chart.tsx`, `src/components/range-picker.tsx`, `src/lib/format.ts`, `test/format.test.ts`

### Checkpoint 2
- [x] Gate green; `mobile:check` passes everywhere at 393 px, and the desktop screenshots are unchanged
- [x] Staging deploy; Scott checks on his iPhone from the home screen (Success criterion 7): "Things look good on my phone" (2026-11-08)
- [x] SPEC-dashboard success criteria 1–6 met; PR #66 merged, plus the follow-up #67

## Risks
| Risk | Mitigation |
|---|---|
| Running `next dev` locally against staging needs the dashboard's secrets | It uses the documented local mode (SSM, read-only role, dev bypass only under `next dev`); nothing is committed |
| Playwright's WebKit isn't exactly iOS Safari | It catches layout problems reliably; home-screen details (safe areas, status bar, refresh on resume) are confirmed on Scott's phone at Checkpoint 2 |
| Cards hide data people relied on | The spec's rule: every figure is shown or one tap away; dropping a figure means asking first |
