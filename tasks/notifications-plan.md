# Implementation Plan: `notifications`

> Implements [SPEC-notifications.md](../SPEC-notifications.md) (approved 2026-10-31). Tasks are in [notifications-todo.md](notifications-todo.md).
> **Status: DRAFT — awaiting approval.**

## Overview

Two tracks run in parallel:
- **Code (N1–N5):** pure routing and composition, then the outbox, then the two jobs and the Cloudflare mailer, then scripts and docs. All of it is testable offline.
- **DNS (N6):** the whitebirch.io move, which you lead and I check at each step.

The tracks meet at N7. Staging is checked with `notify:test` and suppressed rows; production with a real test send, then the first digest after a trading day's close.

## Dependency graph

```
N1 routing + Mailer port ──┬── N3 outbox + migration ──┬── N4 notify-urgent / notify-digest jobs + CloudflareMailer
N2 compose (urgent, digest)┘                           │            │
                                                       │     N5 notify:test / notify:preview + docs
N6 DNS move (you lead; any time) ──────────────────────┴────────────┴── N7 verify staging → PR → production
```

## Architecture decisions (made during planning)

- **`AUDIT_KINDS` becomes a runtime array** (the `AuditKind` type is derived from it). Then the "every kind is routed" test can iterate it, and adding a kind without routing it fails the build. That's the guard against later modules forgetting.
- **Claim-then-send outbox.** `deliver` flips `pending → sending` with a conditional update. The one run that wins sends the email, then records `sent` + `messageId`, or `pending` again with `attempts + 1` and a `next_attempt_at` backoff (1, 5, 15, 60 minutes). It becomes `failed` after 5 attempts. A run that crashes mid-send leaves a row `sending`, which is retried once it's 10 minutes old. The worst case is one duplicate email, never a lost one.
- **Suppression is decided at enqueue time** from `TRADING_ENV`. Staging rows are written `suppressed` unless their type is `test`. The code path is identical in both environments; only the final send differs.
- **`job.failed` throttling** happens at enqueue time: at most one urgent email per job name per 6 hours. Later failures inside the window are still marked as covered in `notification_items`, so they don't pile up, and the next email says how many were folded in.
- **Schedule order** within the `*/15` tick: `heartbeat` → `sync-broker` → `notify-urgent` → `notify-digest`. That way a halt tripped by this tick's sync is emailed in the same tick, and the digest (run at the close + 30 tick, 16:30 ET) sees the after-close sync's data.
- **`JobDeps` gains `mailer`.** The engine builds a `CloudflareMailer` over the `EMAIL` binding. Tests and scripts use a fake mailer or a dry-run one.

## Task list

### Phase 1: Pure pieces
- [ ] N1: `AUDIT_KINDS` array, `routing.ts`, `Mailer` port
- [ ] N2: `compose.ts`: urgent and digest emails (text + HTML)

### Phase 2: Delivery
- [ ] N3: Migration (`notifications`, `notification_items`) + `outbox.ts`
- [ ] N4: `notify-urgent` and `notify-digest` jobs + `CloudflareMailer` + `send_email` binding

### Checkpoint A
- [ ] Gate green · `db:generate` clean · you skim a sample urgent email and a sample digest (rendered in the PR description)

### Phase 3: Operate
- [ ] N5: `notify:test`, `notify:preview` + docs (SETUP DNS section, CLAUDE.md)
- [ ] N6: whitebirch.io DNS move + Email Routing (you lead, I check each step)
- [ ] N7: Verify staging → PR → production

### Checkpoint B (complete)
- [ ] All 6 success criteria · you review · next: `SPEC-portfolio.md`

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| DNSSEC left on during the nameserver switch | High (domain unresolvable) | Step 2 is a hard gate: I confirm the DS record is gone with `dig` before you switch. |
| A DNS record missed in the move breaks the site or GitHub verification | Med | Your registrar inventory, compared record by record against the Cloudflare import before the switch, then re-checked through Cloudflare's nameservers. |
| Forwarding gap during propagation | Low | Both paths forward to Gmail while resolvers catch up. The Squarespace forwarding stays configured until the switch has fully propagated. |
| `wrangler deploy` rejects the `send_email` binding before Email Routing is set up | Med | If it does, N4's binding lands only after N6. The code still merges, with the mailer failing closed (rows stay `pending`, nothing breaks). |
| Email failures affecting trading jobs | Med | Notify jobs run last in the tick, under `runJob`'s own error capture. A failure is a `job.failed` row and never undoes a sync. |
| Duplicate emails after a crash mid-send | Low | Accepted as the worst case (one duplicate). Never a silent loss. |

## Open questions

- None.
