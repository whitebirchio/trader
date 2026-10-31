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
- [ ] Gate green · `db:generate` clean · Scott skims the sample urgent email and digest (in the PR description)

## Phase 3: Operate

### N5: Scripts + docs
- **Acceptance:**
  - [ ] `notify:test --env <env>` (queues a `test` email that the next tick sends) and `notify:preview --env <env> [--digest]` (prints, sends nothing)
  - [ ] `docs/SETUP.md` "Email" section (DNS move steps, catch-all, binding); `CLAUDE.md` architecture line
- **Depends on:** N4 · **Scope:** S

### N6: DNS move (Scott leads)
- **Acceptance:**
  - [ ] *(Scott)* inventory from Squarespace (DNS records + forwarding)
  - [ ] *(Scott)* DNSSEC off; *(me)* DS record confirmed gone
  - [ ] *(Scott)* zone added to Cloudflare; *(me)* import checked against the inventory, GitHub Pages records DNS-only
  - [ ] *(Scott)* Email Routing: Gmail verified, catch-all → Gmail
  - [ ] *(Scott)* nameservers switched; *(me)* site, GitHub challenge and MX checked through Cloudflare's nameservers; *(Scott)* test email to a random @whitebirch.io address arrives
  - [ ] *(Scott)* DNSSEC re-enabled in Cloudflare and its DS added at the registrar; *(me)* DS confirmed
- **Depends on:** — · **Scope:** manual

### N7: Verify and ship
- **Acceptance:**
  - [ ] SC-3: staging `notify:test` arrives with `[paper]`
  - [ ] SC-4: staging `risk:kill` / `risk:resume` → one suppressed urgent row each; re-tick → nothing new
  - [ ] SC-5: Monday after the close, a suppressed staging digest for 2026-11-02 (`notify:preview` shows it)
  - [ ] SC-6: PR → production; *(Scott)* `notify:test --env production` arrives; first production digest after a close
- **Depends on:** N5, N6 · **Scope:** S

### Checkpoint B
- [ ] All 6 success criteria · Scott reviews · next: `SPEC-portfolio.md`
