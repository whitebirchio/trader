# Spec: `notifications`

> **ADR-018 (2026-11-11): staging is retired.** Production is the only deployed environment. Where this spec runs a command with `--env staging`, paper work now uses `--env paper` (the paper account on a local database), and checks of the deployed system use `--env production`. Records of what was checked on staging stay as written.

> **Delivery superseded:** outbound email moved from the Cloudflare `send_email` binding to AWS SES on 2026-11-01 ([SPEC-platform-aws.md](SPEC-platform-aws.md)). Routing, the outbox, composition and suppression are unchanged. Inbound forwarding stays on Cloudflare Email Routing.

> **Status: Approved** (Scott, 2026-10-31). Module 4 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `foundation` (the audit log). Built before `portfolio` so you hear about halts and trades from the first live order (SPEC-risk resolved question 2).

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
