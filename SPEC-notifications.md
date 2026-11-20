# Spec: `notifications`

> **ADR-018 (2026-11-11): staging is retired.** Production is the only deployed environment. Where this spec runs a command with `--env staging`, paper work now uses `--env paper` (the paper account on a local database), and checks of the deployed system use `--env production`. Records of what was checked on staging stay as written.

> **Delivery superseded:** outbound email moved from the Cloudflare `send_email` binding to AWS SES on 2026-11-01 ([SPEC-platform-aws.md](SPEC-platform-aws.md)). Routing, the outbox, composition and suppression are unchanged. Inbound forwarding stays on Cloudflare Email Routing.

> **Status: Approved** (Scott, 2026-10-31). Module 4 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `foundation` (the audit log). Built before `portfolio` so you hear about halts and trades from the first live order (SPEC-risk resolved question 2).

> **Email design (2026-11-15, approved):** a redesign of how every email looks and reads is proposed in [§ Email design](#email-design-2026-11-15). Assumption 2 below ("plain, readable email") still holds: no images, no tracking.

## Objective

Email you about what Trader does, without you having to look. Every meaningful autonomous action is already an audit event (ADR-008). This module turns those events into email:

- **Urgent events go out immediately**, within one 15-minute tick: anything that stops trading, or needs you.
- **Everything else goes in one daily digest** after each trading day's close: fills, clips, rejections, and an account summary.
- **Delivery is reliable and never doubled.** Emails are queued in an outbox before sending, keyed by the audit events they cover. A failed send is retried, and a redelivered cron tick or an overlapping run never sends twice.
- **Cost is $0.** Cloudflare Email Routing's send-to-verified-address path is free on the Workers Free plan and doesn't count toward any quota.

## Which events go where

| Urgent (immediately) | Digest (after close) |
|---|---|
| `risk.halted` · `risk.kill_switch_on` · `risk.resumed` | `order.submitted` · `order.filled` · `order.partially_filled` |
| `risk.buys_paused` | `order.canceled` · `order.rejected` |
| `broker.config_unsafe` · `broker.account_changed` · `broker.reconcile_mismatch` | `risk.order_clipped` · `risk.order_rejected` |
| `broker.trading_allowed` (recovery) | `risk.buys_resumed` |
| `order.external` (someone traded outside Trader) · `order.unknown` | |
| `job.failed`, throttled to one email per job per 6 hours | |

**SEC filings (#105, 2026-11-11):** `filing.sell_signal` is urgent: an officer or director leaving (an 8-K item 5.02 that mentions it), or selling on the open market outside a 10b5-1 plan, on a held name. Nothing is sold; Claude weighs it at the next run. `filings.noticed` goes in the digest's "SEC filings" section: every other new filing from the last 3 days on a held or watched name (non-trade Form 4s left out), with watchlist names and sell signals marked.

**Lessons (#28, 2026-11-12):** `lessons.recorded` goes in the digest's "Lessons" section: one line per post-mortem Claude wrote on a closed thesis, with how it ended and its excess over VTI, marked `[revised]` when it replaces an earlier one. No trading effect, so never urgent.

**Event triggers (2026-11-18, SPEC-agent § Event-triggered runs):** `events.tripped` goes in the digest's "Watch: event triggers" section: a held thesis within 3% of its stop, 8% or more from the previous close, or with a sell-signal filing, once per trigger per symbol per day. Nothing is sold. With routine tokens set, pending trips start a focused research run (inside a window, at most two a day): `routine.event_run_result` goes in the digest's "Event runs" section (what tripped, whether the run started), `routine.event_run` (the claim before the call) is ignored, and a `filing.sell_signal` email says when a run started for that filing.

**Missed research runs (2026-11-12):** `routine.missed` is urgent: a scheduled research run submitted no strategy within 45 minutes of its fire time on a trading day (SPEC-agent § The routine). The last strategy keeps executing; the email says which version, and that the usual cause is the account's weekly usage limit. *(2026-11-13, SPEC-agent § Missed-run recovery)* With routine tokens configured, `check-routine` first re-fires the run at +30 and +90 minutes: `routine.retry_result` goes to the digest ("Research run retried"), `routine.retry` (the claim before each call) is ignored, and `routine.missed` comes 45 minutes after the last try, or at once when a try is refused, saying what was tried.

`order.intent` isn't emailed: `order.submitted` or `order.rejected` always follows it. When `portfolio` and `agent` add new kinds (e.g. `strategy.activated`), each one gets put in a column as part of its own module.

**The digest** is sent once per trading day, about 20 minutes after the close. It lists:
- equity, cash, and today's flow-adjusted change (from `risk`'s index)
- current positions
- every digest event of the day, grouped as Trades, then Guardrail decisions
- the guardrail state (kill switch, halt, drawdown)

It goes out **every trading day**, quiet days included (Scott, 2026-10-31), so its arrival doubles as "Trader is alive". There's no digest on weekends and market holidays: nothing trades and nothing syncs. `portfolio` adds a vs-VTI line later.

**The weekly letter** (#38, `tasks/weekly-letter-plan.md`) says whether the strategy is working. `notify-weekly` sends it on the week's last session (the next session is in a later week, from Alpaca's calendar, so holiday weeks still get one), an hour after the close and once that day's after-close equity snapshot exists. It covers:
- the week's flow-adjusted return vs VTI's over the same days, and the same since the start
- the scorecard's track record (overall and by kind), and each thesis opened or closed this week
- *(2026-11-13, the forecast ledger)* one forecasts line: how many resolved this week and how many beat VTI (backfilled ones counted apart, not scored), and the running skill score against the 45% base rate, or "too few to judge" below 30 resolved
- each strategy version that changed something, with the first line of its summary; resubmissions that only reaffirmed it are counted, not listed
- automatic exits (stops, stale, overdue), review dates in the next 14 days, and the guardrail state

One letter per week: `notifications.week_of` (the week's Monday) is unique. Staging writes it as `suppressed` like the digest.

## Setup: moving whitebirch.io DNS to Cloudflare

whitebirch.io's DNS is hosted by Squarespace (formerly Google Domains). The domain is registered through Key-Systems and has **DNSSEC on**. Its mail forwarding to Gmail is Squarespace's built-in forwarding, which runs on Mailgun (the `mxa`/`mxb.mailgun.org` MX, SPF and `k1._domainkey` records). The plan **moves DNS to Cloudflare** (free) and **replaces Squarespace forwarding with Cloudflare Email Routing**, which does the same job. That one setup then serves both your forwarding and Trader's emails.

Order matters. Steps marked *(you)* need your registrar or Cloudflare login. I'll write the exact clicks into `docs/SETUP.md` as we go.

1. *(you)* **Inventory.** In Squarespace Domains → whitebirch.io, note every DNS record and every email-forwarding rule (address → destination). From public DNS I found: GitHub Pages `A`/`AAAA` ×8, `www` → `whitebirchio.github.io`, the `_github-pages-challenge-whitebirchio` TXT, and the Mailgun forwarding records. The registrar may hold more that can't be seen from outside.
2. *(you)* **Turn off DNSSEC at the registrar,** then wait for the DS record to disappear. I'll check with `dig DS`. This usually takes a few hours. Skipping this step makes the domain unresolvable for many users after the move.
3. *(you)* **Add whitebirch.io to Cloudflare** (Free plan). Cloudflare imports the records it can find. I'll compare them against the inventory, record by record.
   - The GitHub Pages records stay **DNS-only** (grey cloud), so GitHub keeps managing the site's HTTPS certificate.
   - The GitHub challenge TXT is kept as is.
4. *(you)* **Set up Email Routing** in Cloudflare: verify `scott.schmalz@gmail.com` (you'll get one click-to-confirm email), and recreate today's forwarding: a **catch-all** (every @whitebirch.io address → your Gmail). Cloudflare then replaces the Mailgun MX/SPF records with its own. The Mailgun DKIM (`k1._domainkey`) can be dropped.
5. *(you)* **Switch nameservers** at the registrar to the two Cloudflare gives you. During propagation (minutes to a day), mail arrives through either path, and both forward to Gmail.
6. **Verify.** I'll check through Cloudflare's nameservers that the site, the GitHub challenge and the MX records resolve. You send a test email to a forwarded address from another account. Then *(you)* re-enable DNSSEC in Cloudflare and add its DS record at the registrar.

Trader's sending uses a Workers `send_email` binding restricted to your verified address, from `trader@whitebirch.io`. That address doesn't need a forwarding rule of its own.

## Assumptions (correct any of these)

1. **Staging is silent apart from test sends** (Scott, 2026-10-31). Staging still builds and queues its emails, so the code path is exercised and visible in the `notifications` table, but it marks them `suppressed` instead of sending. Only `notify:test` emails (type `test`, subject prefix `[paper]`) are actually sent from staging. Production sends everything.
2. **Plain, readable email.** Plain text plus a minimal HTML version (no images or tracking), using the human-readable reasons `risk` already writes. Subjects lead with what happened, e.g. `Trader: HALTED, account down 20.1% from peak` or `Trader daily: +0.42%, 3 trades (Mon Nov 2)`.
3. **One urgent email per event, grouped per tick.** Several urgent events in the same 15-minute tick go out as one email listing them all, so a messy moment doesn't become a burst of emails.
4. **The outbox is the source of truth for delivery.** A `notifications` table holds each email with its audit event ids, status, attempts and Cloudflare `messageId`. Each audit event belongs to at most one email of each type (urgent or digest).
5. **No inbound handling.** Replies to `trader@whitebirch.io` aren't processed. Talking to Trader is `agent`'s job, through MCP.

## Tech Stack

No new npm dependencies. The engine Worker gets a `send_email` binding (`EMAIL`, restricted to your verified address). Core defines a `Mailer` port, and the engine adapts the binding to it. Tests use a fake mailer.

## Commands

```sh
npx vitest run notifications                                         # (in packages/core) routing, outbox, digest, throttling
npm run notify:test -w @trader/core -- --env staging                 # queue a test email through the outbox (sent on the next tick)
npm run notify:preview -w @trader/core -- --env staging --digest     # print today's digest without sending
npm run notify:preview -w @trader/core -- --env staging --weekly --date 2026-11-06   # print that week's letter without sending
```

## Project Structure

```
packages/core/src/notifications/
  port.ts       → Mailer interface ({ send(message) → { messageId } })
  routing.ts    → audit kind → urgent | digest | ignore (pure)
  compose.ts    → urgent email and digest text/HTML (pure, snapshot-tested)
  outbox.ts     → enqueue (idempotent per audit event), deliver (claim, send, mark, retry)
  jobs.ts       → `notify-urgent` (every tick), `notify-digest` (after-close window), `notify-weekly` (the week's last session)
  weekly.ts     → the weekly letter's data from snapshots, VTI closes, the scorecard and strategy versions
apps/engine/src/mailer.ts → CloudflareMailer over env.EMAIL
```

### Data model (migration, additive)

| Table | Purpose |
|---|---|
| `notifications` | `id`, `type` (`urgent` / `digest` / `weekly` / `test`), `digest_date` (unique per date for digests), `week_of` (unique per week for letters), `subject`, `text`, `html`, `audit_event_ids` (uuid[]), `status` (`pending` / `sending` / `sent` / `failed` / `suppressed`), `attempts`, `last_error`, `message_id`, `created_at`, `sent_at` |
| `notification_items` | (`audit_event_id`, `type`) unique. This is the guarantee that an event is emailed at most once per type. |

## Testing Strategy

- **Routing** (pure): every `AuditKind` is assigned to exactly one of urgent, digest or ignore. A test fails when a new kind is added without a decision, so new modules can't forget.
- **Compose** (pure, snapshot): urgent emails for each urgent kind; a busy digest; a quiet-day digest; the `[paper]` prefix on staging test sends.
- **Outbox** (PGlite + fake mailer): staging suppresses everything but `test`; enqueue twice gives one email; a send failure retries with backoff and gives up after 5 attempts with `failed`; two overlapping deliveries send once; `job.failed` throttling.
- **Digest job:** runs only on trading days, in the after-close window, once per date (redelivery-safe).
- **Live:** `notify:test` on staging reaches your Gmail; a staging `risk:kill` produces an urgent email within one tick.

## Boundaries

- **Always:** queue before sending; include both text and HTML; send only to the verified owner address; keep each email to what changed and why (the reasons `risk` and `broker` already write).
- **Ask first:** emailing anyone but you; adding a paid email path; changing which kinds are urgent.
- **Never:** put secrets, API keys or full account numbers in an email; let notification failures affect trading jobs (notify jobs run after the others in the tick and catch their own errors); make DNS changes to whitebirch.io without walking through the plan above with you.

## Success Criteria

1. Gate green; every audit kind is routed.
2. DNS move done: the site and the GitHub verification still resolve, your existing forwarding still reaches Gmail, and DNSSEC is re-enabled.
3. `notify:test` on staging lands in your Gmail from `trader@whitebirch.io` with a `[paper]` subject.
4. Staging `risk:kill` queues one urgent notification within 15 minutes (status `suppressed`, nothing sent), and `risk:resume` another. Re-running the tick queues nothing more.
5. Monday after the close: one staging digest row for 2026-11-02 (`suppressed`) covering the B9 smoke trade, previewable with `notify:preview`.
6. Production: the binding is deployed, `notify:test --env production` arrives (you run it), and the first production digest arrives after a trading day's close. **No trading behaviour changes.**

## Resolved Questions (2026-10-31)

1. **Forwarding today is a catch-all:** every @whitebirch.io address goes to your Gmail. It's recreated as an Email Routing catch-all rule in setup step 4.
2. **Staging is silent apart from test sends** (assumption 1).
3. **A digest every trading day,** quiet days included.

## Email design (2026-11-15)

> **Status: Approved** (Scott, 2026-11-15), with the open questions resolved below. **PR 1 built** (#131: the layout, every urgent email, the strategy email). **PR 2 built** (2026-11-19: the digest and the weekly letter). Prompted by the v21 "New strategy" email (2026-11-13): one 1,000-character bullet, then double bullets. Plan: [tasks/email-design-plan.md](tasks/email-design-plan.md).

### Objective

You read every Trader email in Gmail, on desktop and on your phone. Each one should answer **what happened, does it need me, and what changed** on the first phone screen, with the detail below it for when you want it.

Today every email is a heading plus a `<ul>` with one `<li>` per line that `describe()` returns. The v21 email shows what goes wrong:

1. **Double bullets.** `plainLines()` starts each line with `• `, and the HTML wraps each line in an `<li>` too. The broker safety check and strategy-rejected emails do the same (`• ${reason}`).
2. **A wall of text.** Claude's summary arrives as one paragraph that re-judges every thesis inline, and then the plain summaries cover the same theses again.
3. **No hierarchy.** "In plain terms:" is itself a bullet, every line looks the same, and each thesis's weight, stop and review date are buried in prose.
4. **An unchanged version reads as news.** The subject was "New strategy v21" for a resubmission that changed nothing. Since #129 every research run submits, so this happens about twice a day.
5. **Lines that no longer say anything.** "systematic: top 1 of 1 symbols" means nothing now that the sleeve only holds VTI (ADR-013). The timestamp appears twice.
6. **A wasted inbox preview.** Gmail shows "New strategy v21 by claude Fri, Nov 13, 12:31 PM ET" under the subject, not the gist.

### What changes

**1. One layout for every email** (`notifications/layout.ts`, pure). Compose functions stop building strings. They return a document: a title, an optional subtitle, a preheader, a tone, and blocks. One renderer turns that into both the HTML and the text part, so the two can't drift apart, and no content string carries its own bullet.

| Block | HTML | Text |
|---|---|---|
| `heading` | section heading, small caps, muted | blank line, then the heading |
| `paragraph` (`lead` for emphasis) | body text (larger when `lead`) | the paragraph |
| `list` | `<ul>`, items as given | `- item` |
| `stats` | 2–4 label/value tiles in one row, wrapping on a phone | `Label: value` per line |
| `table` | header row and right-aligned numbers | aligned columns |
| `card` | title, badge (e.g. `8%`), optional tag (`New`, `9% → 7%`), body, muted meta line | title line, indented body and meta |
| `callout` | a tinted box with a left bar in the tone's colour | `! ` before the text |
| `note` | small, muted text | the text |

HTML rules: inline styles only (Gmail drops most `<style>`), one centered column at most 600px wide, the system font stack at 15px with 1.5 line height, no images, web fonts, tracking pixels, or links beyond those already in the content (sec.gov filings, claude.ai) and the dashboard (resolved question 6). A hidden preheader sets Gmail's inbox preview. Colours and status icons follow the dashboard (resolved question 3). It has to stay legible when Gmail's dark mode inverts it, so no text is set on a coloured background except in callouts. Every string from outside the code (Claude's summaries, broker reasons, filing summaries) is escaped.

**Tones.** Each urgent kind has one (`TONES` in `compose.ts`; a routing test fails if an urgent kind has none):
- **red,** trading stopped or money moved unexpectedly: `risk.halted`, `risk.kill_switch_on`, the broker safety checks, `order.external`, `order.unknown`, `capital.unplanned_outflow`, `capital.transfer_reversed`, `job.failed`
- **amber,** an automatic sale or something to look at: stop-loss, profit target, stale, review overdue, `strategy.rejected`, `routine.missed`, `risk.buys_paused`, `filing.sell_signal`, `capital.command_rejected`, `capital.transfer_canceled`, and `capital.withdrawal_ready` (your turn)
- **green,** a recovery: `risk.resumed`, `broker.trading_allowed`
- **neutral,** for your information: `strategy.activated` and the other capital requests

An email with several events takes the tone of its most severe one, and each event gets its own section.

**2. The strategy email.** This is the main change.

*Subject.* It says whether anything changed, from a diff that code computes against the previous version:
- `Trader: Strategy v22: NVDA 8% added, LKQ exited, BA 9% → 7%` (up to three changes, then `+2 more`)
- `Trader: Strategy v22: stops or review dates moved` (when only those changed)
- `Trader: Strategy v21 reaffirmed, no changes`

*Preheader.* The first line of Claude's summary.

*Body, in order:*
1. **Title**: the subject's headline ("Strategy v22: …"), with the subtitle "by Claude · Fri, Nov 13, 12:31 PM ET".
2. **What changed:** a list from the diff: theses added (weight), exited, resized (old → new weight), and stop, review-date and forecast changes, one line each. When nothing changed: one line, "No changes: same 5 theses, weights, stops and review dates."
3. **Stats:** `Theses 33%` · `VTI 67%` · `5 theses`. The systematic sleeve gets its own tile only when it holds more than VTI.
4. **Claude's take:** the summary's first line as a lead paragraph, then its `Book:` line.
5. **One card per thesis,** largest weight first: the symbol, the weight as a badge, a tag (`New`, `9% → 7%`), the plain summary as the body, then **This run:** with Claude's line for that thesis, and a meta line: "Sells 25% below cost · Review by Mon Dec 14 · Led by insider buying · 60% to beat VTI".
6. **Claude's notes:** whatever is left of the summary, one paragraph per line, in muted text.

*Payload (additive).* `submitStrategy` already has the previous version in hand, so it adds to the `strategy.activated` payload:
- `changed`: whether the document, apart from its summary, differs from the previous version (the weekly letter's rule, moved into one shared function)
- `changes`: `added`, `removed`, `resized` and `moved` (stop, review date, forecast), with symbols and weights
- `cards`: for each thesis, its symbol, id, weight, stop, review date, lead signal, chance to beat VTI and plain summary

Every existing field stays (the agent tools and `routine-watch` read them). An older event without the new fields renders as it does today, in the new layout.

*Reaffirmations* (open question 1): whether an unchanged version keeps an urgent email of its own.

**3. Claude writes the summary in lines** (`agent/routine-prompt.md`, ships on merge). The prompt already asks for "one line on each thesis". It will now spell out the format:
- **Line 1:** what changed and why, in one sentence of about 140 characters at most, or "Reaffirmed: no material change."
- **Then one line per held thesis,** starting with its symbol and a colon (`TTMI: held; the estimate cut is narrow and the full year is still rising`). The email moves each of these onto its thesis's card.
- **Then a line starting `Book:`,** then anything else, one point per line.

A line that doesn't match a thesis stays in Claude's notes, and a summary in one paragraph still renders. The plain summary drops its "we sell if it closes X% below… we re-check by…" sentence, since the card shows both. It keeps "what would tell us we're wrong". The dashboard already shows summaries with line breaks (`whitespace-pre-line`), and the weekly letter already takes the first line as the headline.

**4. Other urgent emails.** The wording stays. Each event becomes a section with its headline and its lines as paragraphs. Lists are used only for real lists, such as broker reasons and rejection errors, with the `• ` prefixes removed. The preheader is the first event's first line, and the duplicate timestamp goes.

**5. The daily digest.** The subject stays.
- **Stats:** Equity · Today · Since the start vs VTI · Drawdown. When the guardrails aren't normal, a red callout goes above everything else.
- **Positions:** a table of symbol, shares, value and % of the account, largest first.
- **Trades:** a table of side, symbol, shares and price. Other trade lines (partial fills, cancels, buys funded) follow as a list.
- **Every other section** appears only when it has something. One muted line names the empty ones: "No trades or guardrail decisions today."
- *Built (2026-11-19):* the muted line also names event triggers when none tripped ("No trades, guardrail decisions or event triggers today."), because an empty watch is news too. The "Since" tile shows the account's return with VTI's beneath it; the money-weighted comparison follows the tiles as a small line. Signed figures in tiles and tables get the dashboard's ▲/▼ in colour, in the text part as well. Stat tiles go two to a row when any value is wider than about six characters, so they fit a 375px phone without media queries.

**6. The weekly letter.** The subject stays.
- **Stats:** This week vs VTI · Since the start vs VTI · Equity.
- **Track record:** a table by signal kind, then the forecast line.
- **Theses opened** as cards with their plain summaries; **theses closed** as a table (symbol, how it ended, days held, vs VTI). Reviews, exits and strategy changes stay as lists.
- *Built (2026-11-19):* an empty week collapses into one muted line ("No theses opened or closed this week. No review dates in the next 14 days."). The guardrails are a red callout at the top when they aren't normal, and a muted line at the end when they are. The letter links to `/track-record`.

**7. Previewing.** You shouldn't have to wait for a real event to see an email.
- `notify:preview --sample <name>|all --html <dir>` writes each sample's HTML and text from fixtures, with no database. The v21 email is one fixture. *(Built: the names are `strategy-v21-as-recorded`, `strategy-v21-reaffirmed`, `strategy-v21-old-summary`, `strategy-v22-changed`, `messy-tick`, `digest-busy`, `digest-quiet`, `digest-halted`, `weekly` and `withdrawal`; `EMAIL_SAMPLES` in `samples.ts`.)*
- `--html <dir>` also works on the real previews (`--env production`, `--digest`, `--weekly`).
- `notify:test --env production --sample all` queues the samples as test emails, so they land in Gmail on the next tick.

### Out of scope

Which events are emailed, and when (open question 1 aside); the outbox, routing and SES delivery; images and charts; email to anyone but you; a templating dependency (MJML, react-email). The layout is about 200 lines of TypeScript, and a dependency would buy little for one reader on one client.

### Commands

```sh
npx vitest run notifications layout                                   # (in packages/core)
npm run notify:preview -w @trader/core -- --sample all --html .cache/email-preview
npm run notify:preview -w @trader/core -- --env production --digest --html .cache/email-preview
npm run notify:test -w @trader/core -- --env production --sample all  # the samples to your Gmail on the next tick
npm run typecheck && npm test
```

### Project structure

```
packages/core/src/notifications/
  layout.ts     → (new) the block types, tones, and render(doc) → { html, text }
  compose.ts    → describe() and composeUrgent/Digest/Weekly return documents; the strategy email's sections
  strategy-email.ts → (new) the strategy email: diff to subject, summary lines to cards
  samples.ts    → (new) sample emails for notify:preview, notify:test and the tests: v21 as recorded, v21 in the line format, a made-up v22, a messy tick
packages/core/src/portfolio/
  strategy-diff.ts → (new) sameExceptSummary(a, b) and strategyChanges(prev, next); weekly.ts uses sameExceptSummary too
  store.ts      → activationPayload(): the payload, with changed, changes and cards (pure, so samples build theirs the same way)
packages/core/scripts/notify-preview.ts, notify-test.ts → --sample, --html
agent/routine-prompt.md → the summary format and the shorter plain summary
```

### Code style

A compose function returns data, and the renderer owns the markup:

```ts
return {
  title: `Strategy v${p.version}`,
  subtitle: `by ${by} · ${when(e.at)}`,
  preheader: lead,
  tone: "neutral",
  blocks: [
    { type: "heading", text: "What changed" },
    changes.length ? { type: "list", items: changes } : { type: "paragraph", text: noChanges },
    { type: "stats", items: [{ label: "Theses", value: `${p.convictionPct}%` }, { label: "VTI", value: `${vti}%` }] },
    ...cards.map((c) => ({ type: "card", title: c.symbol, badge: `${c.weightPct}%`, tag: c.tag, body: c.plain, meta: c.meta })),
  ],
};
```

### Testing strategy

- **Layout** (pure): every block escapes its text; the text part holds every string the HTML does; no list item or paragraph starts with a bullet character (this test would have caught the double bullets); every sample stays under 60KB; no flex or grid; every urgent kind has a tone.
- **Strategy diff** (pure): added, removed, resized, stop or review moved, forecast changed, unchanged, and the first version against version 0.
- **Strategy email:** each subject variant; the reaffirmed body; summary lines matched to cards, unmatched lines kept as notes, a one-paragraph summary; an old payload with no `cards` or `changes`; the v21 fixture end to end.
- **submitStrategy** (PGlite): the payload carries `changed`, `changes` and `cards`; resubmitting unchanged gives `changed: false`.
- **Existing compose tests:** the wording assertions keep passing against the text part, with only the `• ` expectations changing.
- **By eye:** each sample's HTML in the browser pane at 375px and 1000px wide, then in Gmail on desktop and the iOS app (light and dark) through `notify:test --sample all`.

### Boundaries

- **Always:** inline styles only; escape every string; the text part says everything the HTML does; keep the existing wording unless this section changes it.
- **Ask first:** changing which events are urgent (open question 1); adding a dependency; sending the samples to Gmail (`notify:test --env production`, which writes to the production outbox).
- **Never:** images, remote content or tracking; secrets or account numbers; changes to the outbox, routing or delivery beyond what this section says.

### Success criteria

1. No email has a double bullet. The layout test enforces it.
2. On a 375px-wide screen, the v21 fixture shows the title, "No changes", the stats and Claude's first line before the first thesis card, within about 600px of height.
3. Each thesis's weight, stop and review date can be read without reading any prose.
4. The subject says whether the strategy changed, and Gmail's inbox preview shows Claude's first line.
5. The samples look right in Gmail on desktop and the iOS app, in light and dark mode. You confirm this from the `notify:test` samples.
6. The gate is green, and which emails are sent, and when, is unchanged unless open question 1 changes it.

### Resolved questions (Scott, 2026-11-15)

1. **Reaffirmations go to the digest.** A version that changes nothing (`changed: false`) gets no urgent email of its own. The daily digest lists it under "Research runs" ("8:05 AM · v20 reaffirmed: no material change"). A version that changes something still emails at once, and a missed run still emails (`routine.missed`). Routing picks this by payload: `routeEvent(kind, payload)` in `routing.ts`, with `strategy.activated` the only kind whose route depends on its payload. An older event without `changed` stays urgent.
2. **Per-thesis lines are `SYMBOL:` lines in the summary.** No schema change.
3. **The look follows the dashboard,** not a new palette: the page in `#f6f6f4`, content in bordered `#fcfcfb` cards with 12px corners, text `#0b0b0b`, muted `#6b6a66`, borders `#e3e2de`, bordered muted badges, tabular figures, and status shown as an icon plus a label, never colour alone (● good `#0c8a0c`, ▲ warn `#b77400`, ■ bad `#c43535`), with ▲/▼ beside signed figures. Clients that honour `prefers-color-scheme` (Apple Mail) get the dashboard's dark palette. Gmail inverts on its own. So the tones above become **bad, warn, good and neutral**, each shown as its icon beside the headline, not as a coloured bar.
4. **Three PRs,** in the order proposed. The one change: the summary-format prompt edit ships with PR 1, not PR 3, because the strategy email reads best with it, and a prompt edit ships on merge.
5. **Dependencies are allowed.** Scott offered them; none earned their place. React Email's render is async (every compose call site would change, and React would enter core), MJML is heavy with known esbuild bundling problems, and juice only inlines CSS, which the renderer writes directly. The layout stays about 200 lines with no dependency. Revisit if a second mail client matters.
6. **Links to the dashboard** (added in planning): each thesis card links to its page (`/theses/<id>`), and each email ends with a link to the relevant page (`/strategy`, `/activity`, or the overview). These go to the owner's own site (`trader.whitebirch.io`), with no tracking, and are left out on the paper env.
