# Plan: email design

Spec: [SPEC-notifications.md § Email design](../SPEC-notifications.md#email-design-2026-11-15) (approved 2026-11-15). Branch per PR, each cut from main.

## PR 1: the layout, every urgent email, the strategy email

1. **`notifications/layout.ts`** (pure): `EmailDoc` (title, subtitle, preheader, sections), the block types, `Tone`, `render(doc) → { html, text }`. Inline styles from one style table in the dashboard's palette, a table-based 600px column, a hidden preheader, a `<style>` block only for phone widths and `prefers-color-scheme: dark`. It escapes everything.
2. **`portfolio/strategy-diff.ts`** (pure): `sameExceptSummary(a, b)` (canonical JSON, so key order can't matter) and `strategyChanges(prev, next)` (added, removed, resized, moved stop/review/forecast, other edits). `weekly.ts` switches to `sameExceptSummary`.
3. **`submitStrategy`** adds `previousVersion`, `changed`, `changes` and `cards` to the `strategy.activated` payload. The existing fields stay.
4. **`compose.ts`:** `describe()` returns `{ headline, tone, preheader, blocks }`. `• ` prefixes become `list` blocks. `composeUrgent` builds one document (a section per event, most severe first) and renders it. The strategy email (`strategy-email.ts`): subject from the diff, "What changed", stats, Claude's take, cards with "This run" lines from `SYMBOL:` lines, notes. An old payload with no `cards` renders the plain-terms list as cards.
5. **Routing:** `routeEvent(kind, payload)`. `strategy.activated` with `changed: false` → digest. `queueUrgent` and the digest query select by the kinds that may take each route, then filter. The digest gets a "Research runs" section (in its current format until PR 2).
6. **Prompt:** the summary format (headline line, `SYMBOL:` lines, `Book:`), and the plain summary drops the stop/review sentence.
7. **Tooling:** `notify:preview --sample <name>|all --html <dir>` from fixtures (`test/notifications/fixtures.ts`, shared with tests); `notify:test --sample <name>|all`.
8. **Verify:** gate; samples served locally and screenshotted at 375px and 1000px; then Scott's OK to send the samples to Gmail via `notify:test --env production --sample all`.

## PR 2: digest and weekly letter
`composeDigest` and `composeWeekly` move onto the layout: stats, tables, empty sections collapsed into one line, signed figures with ▲/▼.

## PR 3: what's left
Anything PR 1 and 2 surfaced. The prompt moved to PR 1.

## Risks
- **Gmail clips HTML over 102KB.** Styles are compact, and a test keeps the busiest fixture under 60KB.
- **Unsupported CSS in Gmail:** no flex/grid, only tables. `<style>` is used only for progressive extras.
- **Routing by payload** must not lose events: an event whose route is digest is still covered by the digest's `notification_items`. A test covers a reaffirmation landing in the digest and not in urgent.
