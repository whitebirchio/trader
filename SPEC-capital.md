# Spec: `capital`

> **Status: Approved** (Scott, 2026-11-01). Module 8 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `broker`, `risk`, `portfolio`; changes `agent`, `dashboard` and `notifications`. Decision record: [ADR-015](docs/decisions/015-owner-capital-flows.md).

## Objective

Scott can move money into and out of the Trader account whenever he likes, in any amount, and Trader handles it as a first-class event rather than a disturbance:

- **Deposits are Alpaca-native.** Deposit in Alpaca. Trader notices, records it, invests it under the current strategy at the next rebalance step (no idle money), and tells Claude on its next run.
- **Withdrawals are requests.** Scott asks for $X (dashboard or CLI). **Claude decides where the money comes from** by authoring a strategy for the smaller account. If Claude doesn't decide in time, a deterministic fallback does. Deterministic code sells, holds the proceeds, and tells Scott when they're settled. Scott moves the cash out in Alpaca, and Trader matches the transfer and closes the request.
- **An owner withdrawal always goes through the drawdown halt.** It's a human decision to take his own money out (Scott, 2026-11-01).
- **No flow distorts anything:** not drawdown, not the daily-loss pause, not the comparison with VTI.

Success: Scott deposits and withdraws without thinking about Trader, and every guardrail, number and email stays right.

## Decisions (Scott, 2026-11-01)

1. **Fallback funding:** take from VTI and the systematic sleeve first and keep thesis dollars whole. Trim theses only if the rest isn't enough.
2. **Withdrawals pass the drawdown halt, not the kill switch.** The kill switch stays absolute: it means "the engine may be broken, touch nothing", and Scott can turn it off himself.
3. **The dashboard gets withdrawal controls from the start.**
4. **Deposits are invested immediately** under the current strategy. Claude can re-weight on its next run. This is also the simpler path: it's today's behaviour and needs no new code, whereas holding deposits would need a deposit reserve, a deadline and a fallback.

## Concepts

### 1. The capital ledger

`capital_flows`: one row per external transfer, copied from `broker_activities` (Alpaca's `CSD`, `CSW`, `JNLC`, `JNLS`) by the `sync-broker` job right after each sync, and before the drawdown check. It's append-only. The first run backfills the history, and a withdrawal request links to its flows from its own side.

| Column | Meaning |
|---|---|
| `activity_id` (PK) | the Alpaca activity id |
| `at` | the instant: `created_at`. Date-only fallback: noon ET on `date`, counted in the sync result |
| `amount` | signed `numeric`: + in, − out |
| `kind` | `deposit`, `withdrawal`, `reversal` (a returned instant ACH) |
| `timed_by` | `created_at` or `booking_date` (the approximate case) |
| `status` | Alpaca's activity status, when given |

It is the **single source** for every consumer. The three ad-hoc `FLOW_TYPES` filters (`risk/gate.ts`, `portfolio/benchmark.ts`, `dashboard/views.ts`) go away.

- **Index timing by instant.** A flow is subtracted at the first equity snapshot whose `recorded_at` is after its `at`. Live, the flows since the last snapshot count. This fixes the date-boundary bug: real deposits have been booked a day *after* (live, 2026-04) and a day *before* (paper) their `created_at`, and a big deposit could latch a false halt.
- **Money-weighted VTI comparison.** Over the index's window, close to close: a shadow account "buys" VTI with the equity at the index base (the close before the first trading day), then with every flow inside the window at that market date's close, valued at the latest snapshot's close. Overview and dashboard show *from the base close to the latest close: started with $X, net transfers $T, worth $Y; the same money in VTI → $Z*, plus the all-time net deposits. (Until 2026-11-04 it bought VTI at each deposit's own date, which credited VTI with the months the money sat in cash before Trader ran.) The time-weighted index stays as the risk measure.

### 2. Withdrawal requests

At most one open request at a time. Its lifecycle:

```
requested ──▶ planning ──▶ funding ──▶ settling ──▶ ready ──▶ withdrawn
    │            │            │           │           │
    └────────────┴────────────┴───────────┴───────────┴──▶ cancelled  (cash returns to the strategy)
```

| State | Exits when |
|---|---|
| `requested` | the engine processes the command (next tick) |
| `planning` | Claude submits a strategy after the request, **or** the deadline passes (fallback), **or** Scott taps *Fund now* (fallback immediately). Deadline: the end of the next scheduled routine run (8:00 / 12:00 ET trading days) + 60 min. |
| `funding` | the sells have filled and cash ≥ amount |
| `settling` | Alpaca reports the cash withdrawable (assumption 2) |
| `ready` | an outgoing flow ≥ the outstanding amount posts. A smaller one leaves the remainder `ready`. |

- **Amount:** dollars, or `all` (liquidate, then withdraw everything).
- **Reserved cash:** from `planning` until it closes, investable equity = equity − outstanding amount. That uses the seam `targets.ts` already has (`investable = equity − buffer`). A risk rule also keeps buys ≤ cash − outstanding, as defense in depth.
- **No expiry.** A `ready` request stays until it's withdrawn or cancelled, and the daily digest lists it until then.

### 3. Who decides where the money comes from

Weights are a share of equity, so a smaller account shrinks every target pro rata. Choosing *where* a withdrawal comes from therefore means choosing new weights. **The funding plan is simply the next strategy version**, authored against the post-withdrawal investable equity. No new document type, and no new write tool for Claude.

- **Claude:** `get_overview` shows the pending withdrawal and its deadline. `preview_strategy` previews against post-withdrawal equity and shows, per sell: realized gain/loss, short- vs long-term, and wash-sale windows touched. The routine prompt gets a withdrawal section covering what to weigh: conviction, tax cost, drift, and wash sales (ADR-010). Claude's summary explains the choice in the activation email.
- **Fallback (decision 1):** a `system`-authored version that keeps each active thesis's dollars. Its new weight is current value ÷ (equity − amount), capped at the position cap. VTI and the systematic sleeve absorb the reduction. If thesis value exceeds post-withdrawal equity, theses are trimmed pro rata. System versions don't reset thesis staleness; only Claude reaffirms.
- **Halted (decision 2):** the rebalance still plans from the active strategy, but submits **only sells, tagged `purpose: "withdrawal"`**, in plan order, until the outstanding amount is covered. Risk lets withdrawal sells past the drawdown halt only while their cumulative notional ≤ the outstanding unfunded amount (checked against the DB), so the tag can't be used to bypass the halt. Fresh-data and broker-verdict still block: those are safety, not policy.

### 4. Journeys

**Deposit**
1. Scott deposits in Alpaca.
2. The sync records the flow and emails *Received $X*.
3. The next rebalance step invests it under the current strategy.
4. Claude's next run sees *+$X since your last strategy* and may re-weight.

**Withdrawal**
1. Scott opens Dashboard → Money → *Withdraw*, enters $500 (or *all*), and confirms. An urgent email goes out: *You requested a $500 withdrawal* (an out-of-band notice of every write).
2. The engine opens the request in `planning`, and investable equity drops by $500.
3. Claude's next run submits a strategy for the smaller account (or the fallback does). An email shows Claude's reasoning and the planned sells.
4. Rebalance sells, risk-gated, and the cash settles.
5. An email: *$500 is ready. Withdraw it in Alpaca.* The dashboard shows the same.
6. Scott withdraws in Alpaca. The sync matches the outgoing flow and the request becomes `withdrawn` (email).

**Cancel** at any point before `withdrawn`: the reserve is released, and the next rebalance reinvests the cash under the current strategy.

**Unplanned outflow** (no open request, e.g. Scott withdraws a dividend directly): recorded and flow-adjusted, with an urgent email.

## Changes to other modules (part of this module)

| Module | Change |
|---|---|
| `broker` | The `sync-broker` job calls `recordCapitalFlows` after `syncBroker`, so `broker` itself doesn't depend on `capital`. `toActivity`'s date-only fallback moves to noon ET. The `Account` port exposes withdrawable cash (assumption 2). |
| `risk` | The index reads the ledger by instant. New rules: *withdrawal sells pass the drawdown halt* (bounded) and *buys keep reserved cash*. ADR-012's "freeze everything" gets this one owner exception. |
| `portfolio` | `investable` subtracts the outstanding withdrawal. Fallback strategy builder. Halted withdrawal-only mode. Preview adds realized gain/loss and wash-sale detail per sell. |
| `agent` | `get_overview` gets a `capital` section (pending withdrawal and deadline, flows since the last strategy, money-weighted vs VTI). The preview additions. A routine-prompt section. **No new write tool.** Claude can't create or cancel withdrawals. |
| `dashboard` | A **Money** page: the ledger, contributed / value / same-flows VTI, the open request's timeline, and *Withdraw*, *Fund now* and *Cancel*. The first write path (below). |
| `notifications` | New kinds, routed: `capital.deposit_received` (digest), `capital.transfer_reversed` (urgent, either direction), `capital.transfer_canceled` (urgent), `capital.withdrawal_requested` (urgent), `capital.funding_planned` (urgent, with the reasoning), `capital.withdrawal_ready` (urgent), `capital.withdrawal_completed` (digest), `capital.withdrawal_cancelled` (urgent), `capital.unplanned_outflow` (urgent). The digest lists any open request. |

### The dashboard's write path

The dashboard stays keyless and nearly read-only:

- `trader_dashboard` gains **`INSERT` on one table, `capital_commands`**: append-only, with `{ id, kind: request | cancel | fund_now, amount, requested_by, at }`. It still has no UPDATE or DELETE anywhere, no broker keys and no SES.
- The engine processes commands on its next tick. It validates, transitions the request, and writes the audit event (`actor: "owner"`, carrying the command id).
- Writes: owner session + POST + `Origin` check + a per-form CSRF token (`SameSite=Lax` already blocks cross-site POST cookies). A confirmation step repeats the amount.
- Blast radius if the dashboard were compromised: forced sells and cash held idle. **Money can't leave**, because the ACH is done in Alpaca to the linked bank. Every command emails Scott.

## Assumptions (correct any of these)

1. **The ACH itself happens in Alpaca.** I don't know whether Alpaca's Trading API lets an individual account start transfers; I believe transfers are a Broker-API feature. It's checked in the plan. If it can, starting the ACH from Trader is a follow-up, not v1.
2. **"Settled" comes from Alpaca.** If the account object exposes withdrawable cash, `settling` → `ready` uses it. Otherwise it's computed from fills (T+1 trading days). Checked in the plan.
3. **The engine tick processes commands.** Up to 15 minutes' latency during the session. After hours and on weekends, requests wait for the next tick. Withdrawals are measured in days, so that's fine.
4. **Partial fills and drift** are handled the way the existing rebalance handles them. The `funding` state ends on cash, not on a perfect plan.

## Tech Stack

No new dependencies. Drizzle migrations: `capital_flows`, `withdrawals`, `capital_commands`, and a grant for `trader_dashboard`. All additive. `capital_flows` is backfilled from `broker_activities` by the first `recordCapitalFlows` run, not by the migration.

## Commands

```sh
npx vitest run capital                                                    # (in packages/core) ledger, lifecycle, fallback, rules
npm run capital:status   -w @trader/core -- --env staging                 # ledger totals, open request, money-weighted vs VTI
npm run capital:withdraw -w @trader/core -- --env staging --amount 500    # same command the dashboard writes (owner, laptop)
npm run capital:cancel   -w @trader/core -- --env staging
npm run db:dashboard-role -w @trader/core                                  # proves INSERT on capital_commands only
```

## Project Structure

```
packages/core/src/capital/
  ledger.ts       → activities → capital_flows rows; flows-by-instant for the index (pure)
  withdrawals.ts  → lifecycle state machine (pure transitions) + persistence
  commands.ts     → process capital_commands (validate → transition → audit)
  funding.ts      → fallback strategy builder (pure); halted withdrawal-only selection (pure)
  shadow.ts       → same-flows VTI account (pure)
packages/core/test/capital/   → one file per source file
apps/dashboard/app/money/     → Money page, Withdraw / Fund now / Cancel forms
```

## Code Style

```ts
export type WithdrawalTransition =
  | { status: "funded"; withdrawal: Withdrawal }
  | { status: "unchanged"; reason: string }        // e.g. "cash $312.40 of $500.00"
  | { status: "rejected"; reason: string };        // e.g. "a withdrawal is already open"

/** Pure: what happens to an open request given the latest account state. */
export function advance(w: Withdrawal, account: AccountView, flows: CapitalFlow[], now: Date): WithdrawalTransition;
```

Status unions, decimal strings, `Big` arithmetic, readable reasons (they become email text).

## Testing Strategy

- **Ledger (pure):** `created_at` used; date-only → noon ET on `date`; reversals; the live (booked a day after) and paper (booked a day before) shapes.
- **Index:** a 100% deposit and a 40% withdrawal leave index, drawdown and daily change unchanged, whether same-day, overnight or over a weekend. Existing −20% latch tests unchanged.
- **Lifecycle (pure):** every transition and every cancel point; partial withdrawal; unplanned outflow; one-open-request rule; `all`.
- **Fallback:** thesis dollars kept; caps respected; the theses-exceed-remainder case; staleness not reset.
- **Risk:** withdrawal sells pass the halt up to the outstanding amount and are rejected beyond it; the kill switch still rejects them; buys can't touch reserved cash.
- **Gate/rebalance (PGlite + fake broker):** the end-to-end request → plan → sells → ready → CSW → withdrawn, both normal and halted.
- **Dashboard:** CSRF/Origin rejection; the role can INSERT `capital_commands` and nothing else; forms render each state.
- **Agent:** overview `capital` section; preview tax columns; still no order tools (tool-list pin).

## Boundaries

- **Always:** every state change audited (owner for commands, system for transitions); every command emails Scott; fail closed (an unparseable command is rejected and audited, never guessed).
- **Ask first:** starting ACH transfers from Trader; letting Claude create or cancel a withdrawal; any further dashboard write.
- **Never:** a path that moves money out of Alpaca without Scott; the dashboard holding broker keys or UPDATE/DELETE grants; withdrawal sells beyond the outstanding amount while halted; changing `limits.ts`.

## Success Criteria

1. Gate green; every test above.
2. Staging, deposit: a paper journal in, then `broker:sync --force`. The ledger row, the email (`notify:run`), drawdown ~0, the next `rebalance:plan` invests it, and the vs-VTI numbers don't jump.
3. Staging, withdrawal from the dashboard: request → urgent email → Claude-authored (or *Fund now*) strategy → sells fill → `ready` email. A paper journal out (if paper allows; otherwise a fake-broker test) closes it. Cancel at `ready` reinvests.
4. Staging, halted: with a forced halt in a staging DB fixture, a withdrawal sells only up to its amount, and nothing else trades. With `risk:kill` on, it sells nothing until `risk:resume`.
5. Production, after merge: the Money page shows the April $1,000 deposit, and contributed / value / VTI are correct. Then a **$10 real withdrawal** end to end. That's the only test of a live `CSW` and how its timing lines up with equity.

## Resolved Questions (Scott, 2026-11-01)

1. **Kill switch stays absolute.** Withdrawal sells pass the drawdown halt only.
2. **Claude's decision window** is the end of the next scheduled routine run + 60 min. *Fund now* skips it.
3. **Deposits are invested immediately.** Holding them for Claude would need a deposit reserve, a deadline and a fallback, and would buy little, because the current weights already say where money goes.
