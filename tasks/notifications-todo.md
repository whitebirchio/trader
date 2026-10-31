# Tasks: `notifications`

> Plan: [notifications-plan.md](notifications-plan.md) · Spec: [SPEC-notifications.md](../SPEC-notifications.md)
> **gate** = `npm run typecheck && npm test`. Branches `notifications/*` deploy staging only.

## Phase 1: Pure pieces

### N1: Routing + port
- **Acceptance:**
  - [x] `AUDIT_KINDS` const array in `audit.ts`, with `AuditKind` derived from it (no behaviour change)
  - [x] `notifications/routing.ts`: `routeFor(kind)` → `urgent | digest | ignore`, per the spec table
  - [x] `notifications/port.ts`: `Mailer` + `OutgoingEmail` types
  - [x] Test: every `AUDIT_KINDS` entry routes to exactly one class (a new kind without routing fails the build)
- **Verify:** `npx vitest run notifications/routing`; gate · **Scope:** S

### N2: Compose
- **Acceptance:**
  - [x] `composeUrgent(events, env)` → `{ subject, text, html }`, one email listing every urgent event in the tick, most severe first
  - [x] `composeDigest(data, env)`: equity, cash, the day's flow-adjusted change, positions, the day's trades and guardrail decisions, the guardrail state; a quiet-day variant
  - [x] HTML is minimal and escaped (symbols and reasons are untrusted strings); `[paper]` prefix on staging tests
  - [x] Snapshot tests for a halt, a kill switch, a busy digest, a quiet digest, and HTML escaping
- **Verify:** `npx vitest run notifications/compose`; gate · **Depends on:** N1 · **Scope:** M

## Phase 2: Delivery

### N3: Outbox
- **Acceptance:**
  - [x] Migration: `notifications`, `notification_items` (unique `(audit_event_id, type)`)
  - [x] `enqueue(db, env, email, eventIds, type)` is idempotent per event and type; on staging, writes `suppressed` unless type is `test`
  - [x] `deliver(db, mailer, now)`: conditional claim, send, then `sent`, or a retry with backoff; `failed` after 5 attempts; stale `sending` rows retried
  - [x] `job.failed` throttle: one email per job per 6 hours, later failures folded in
  - [x] Tests (PGlite + fake mailer): idempotency, suppression, retry/backoff/fail, two overlapping delivers send once, throttling
- **Verify:** `npx vitest run notifications/outbox`; `db:generate` clean; gate · **Depends on:** N1 · **Scope:** M

### N4: Jobs + mailer
- **Acceptance:**
  - [x] `notify-urgent`: un-notified urgent events → one email per tick → deliver pending
  - [x] `notify-digest`: trading day and now ≥ close + 20 min and no digest yet for the date → build (from `broker_account`, `positions`, the risk index, the day's digest events) → enqueue → deliver
  - [x] `JobDeps.mailer`; schedule order heartbeat → sync-broker → notify-urgent → notify-digest
  - [x] `apps/engine`: `CloudflareMailer` over `env.EMAIL`; `send_email` binding restricted to the owner address; from `trader@whitebirch.io`
  - [x] Tests: urgent grouping per tick, digest once per date, quiet day, non-trading day skipped, redelivered tick a no-op
- **Verify:** `npx vitest run notifications`; gate · **Depends on:** N2, N3 · **Scope:** M

### Checkpoint A
- [x] Gate green · `db:generate` clean · Scott skimmed the sample urgent email and digest (2026-10-31)

## Phase 3: Operate

### N5: Scripts + docs
- **Acceptance:**
  - [x] `notify:run --env <env>` (queueing step on demand, so checks don't wait for the cron)
  - [x] `notify:test --env <env>` (queues a `test` email that the next tick sends) and `notify:preview --env <env> [--digest]` (prints, sends nothing)
  - [x] `docs/SETUP.md` "Email" section (DNS move steps, catch-all, binding); `CLAUDE.md` architecture line
- **Depends on:** N4 · **Scope:** S

### N6: DNS move (Scott leads)
- **Acceptance:**
  - [x] Inventory: from public DNS (Scott confirmed catch-all forwarding)
  - [x] *(Scott)* DNSSEC off; *(me)* DS confirmed gone at the `.io` registry
  - [x] *(Scott)* zone added to Cloudflare; *(me)* import checked: GitHub Pages A/AAAA (DNS-only), `www`, the challenge TXT all present. **The import dropped MX/SPF**, so mail was undeliverable until Email Routing was enabled.
  - [x] *(Scott)* Email Routing: Gmail verified, catch-all → Gmail; MX/SPF/DKIM published and visible on 1.1.1.1, 8.8.8.8 and 9.9.9.9
  - [x] *(Scott)* nameservers switched (done *before* the record check, out of the planned order, without harm); *(me)* site, GitHub challenge and MX checked through Cloudflare's nameservers; *(Scott)* test email to a random @whitebirch.io address arrives
  - [ ] *(Scott)* DNSSEC re-enabled in Cloudflare and its DS added at the registrar; *(me)* DS confirmed
- **Depends on:** — · **Scope:** manual

### N7: Verify and ship
- **Acceptance:**
  - [x] SC-3: staging `notify:test` sent at 19:30Z via the real binding (message id returned) and confirmed in Scott's Gmail
  - [x] SC-4: staging `risk:kill` / `risk:resume` → one suppressed urgent row each; a re-run → nothing new (via `notify:run`, which runs the same `queueUrgent` the Worker does)
  - [ ] SC-5: Monday after the close, a suppressed staging digest for 2026-11-02 (`notify:preview` shows it)
  - [ ] SC-6: PR → production; *(Scott)* `notify:test --env production` arrives; first production digest after a close
- **Depends on:** N5, N6 · **Scope:** S

### Checkpoint B
- [ ] All 6 success criteria · Scott reviews · next: `SPEC-portfolio.md`
