# Spec: `risk`

> **Status: Approved** (Scott, 2026-10-31). Module 3 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `foundation`, and reads `broker`'s tables.

## Objective

Be the deterministic gate between any proposed order and `submitOrder` (ADR-003). `portfolio` will hand `risk` a list of proposed orders. `risk` returns, for each one, **approved**, **clipped** (resized down to fit a limit) or **rejected**, with reasons, and records every decision. The limits are owner-set code that Claude cannot change, and the halts are owner-cleared state that Claude cannot clear.

When `risk` is done:

- `evaluateOrders(snapshot, proposals, limits, now)` is a **pure function**: same inputs, same decisions, testable without a network or database.
- A `riskGate(db, broker, proposals)` wrapper loads a fresh snapshot (account, positions, verdict, equity history, asset facts), evaluates, persists every decision, and audits each clip and rejection. It is the only code path `portfolio` may use to reach `submitOrder`.
- **The drawdown halt and the kill switch** are persisted, latched state. Only an owner command clears them (`npm run risk:resume`, and later an owner-only MCP tool in `agent`). `sync-broker` checks drawdown on every sync, so a halt trips even on days nothing trades.
- Drawdown and daily-loss are measured on a **flow-adjusted equity index**, so adding money doesn't look like a gain and withdrawing doesn't look like a loss. `portfolio` reuses the same index for VTI comparison.
- **Production still places no orders.** Nothing calls `riskGate` until `portfolio` exists. This module adds a gate and its state, not a trader.

## The limits (your answers, 2026-10-31)

| Rule | Limit | Applies to | When breached |
|---|---|---|---|
| **Kill switch** | owner on/off | every order | reject all, including sells |
| **Drawdown halt** | flow-adjusted equity ≤ **−30% from peak** (−20% until ADR-016) | every order except whole exits of closed theses and withdrawal sells (ADR-017, ADR-015) | latch; reject the rest until **you** run `risk:resume` |
| **Re-halt after a resume** (ADR-017) | after **you** resume a halt: flow-adjusted equity ≤ **−15%** from its level at the resume (the last close before it, or any higher close since), until it regains the pre-halt peak; then the −30% rule again | as the drawdown halt | latch, as the drawdown halt |
| **Daily loss pause** | flow-adjusted equity ≤ **−8% vs prior close** (−5% until ADR-016) | buys | reject buys for the rest of the day; sells still run; clears itself the next trading day |
| **No same-day round trips** (`sameDayRoundTrips: false`, ADR-016) | the symbol was bought today (for a sell) or sold today (for a buy): today's fills plus our orders that may still fill | that order | reject; the planner holds it back with a note until the next trading day |
| **Broker verdict** | `broker_account.trading_allowed` | every order | reject all |
| **Fresh data** | last successful broker sync ≤ 20 min old | every order | reject all (fail closed) |
| **Broad-ETF and cash-equivalent position** | uncapped. Broad: VTI, VOO, … Cash-equivalents: SGOV, BIL, SHV (Treasury bills, added 2026-11-01 so defensive moves can go all the way) | buys | — |
| **Any other position** (single stocks, narrow/sector/thematic ETFs) | ≤ **20%** of equity after the trade | buys | clip to fit, or reject if the remainder is under $1 |
| **Satellite sleeve** | ≤ **30%** of equity after the trade | satellite buys | clip / reject |
| **Leveraged / inverse** | ineligible | buys | reject |
| **Penny / illiquid** | last close < **$5** or 20-day avg dollar volume < **$10M** | buys | reject |
| **Non-fractionable / not tradable** | ineligible | buys | reject |
| **Recent IPO** | < **90 days** of daily bars | buys | reject |
| **Cash** | total buys ≤ cash − buffer. The buffer is **$0** (Scott, 2026-11-01): idle money sits in VTI, not cash. Notional buys can't overspend, and fees come out of sells. | buys | clip the last buys in plan order |
| **No shorting** | sell qty ≤ held qty | sells | clip to held qty |
| **Runaway guard** | ≤ 40 orders per trading day; buy notional ≤ 100% of equity per day | every order | reject the excess |

Sells are never blocked by eligibility, position or sleeve rules: you can always get *out* of something unless the kill switch is on. During the drawdown halt, a whole exit of a single-stock position tagged `purpose: "exit"` (its thesis closed, or it left the strategy) still goes through, but a partial sell, a broad or cash-like ETF sell, or an untagged sell doesn't (ADR-017). There's no minimum holding period. The PDT rule is retired, and wash sales are a strategy cost, not a rule (ADR-010).

## Assumptions (correct any of these)

1. **Limits live in code** (`packages/core/src/risk/limits.ts`), the same for both environments. Changing one is a PR, so it soaks on paper first and the change is reviewed and versioned. Runtime state (kill switch, halt) lives in the database.
2. **Broad-ETF list.** "Broad" is an owner-maintained list in `limits.ts`. Default: VTI, VOO, SPY, IVV, ITOT, SCHB, VT, VXUS, IXUS, VEA, VWO, IEFA, IEMG, BND, AGG, BNDX, SCHZ. Anything not listed gets the 20% cap. Claude can't relabel a holding as broad.
3. **Leveraged/inverse detection** has two layers, and either one blocks:
   - **Sponsor:** the name contains a sponsor that specialises in leveraged, inverse and volatility funds, from an owner-maintained list in `limits.ts` (ProShares, Direxion, GraniteShares, Leverage Shares, Tradr, Defiance, T-Rex, REX Shares, MicroSectors, Volatility Shares). It catches those sponsors' funds whatever they're called.
   - **Name:** the fund name matches Ultra / UltraPro / Bull / Bear / 2x / 3x / Inverse / Leveraged / VIX / Volatility / "Short" (but not "Short-Term" or "Short Duration"). This catches 1× inverse funds like SH and leveraged funds from sponsors not on the list.

   *Revised 2026-11-07 (#33):* the first layer was Alpaca's `margin_requirement_long` ≥ 50. That number moves with Alpaca's volatility adjustments, so it blocked plain stocks (UPBD and HGV at 50, BRK.B at 75 on the live account) and passed VXX (30). Alpaca doesn't mark which assets are funds (all are `us_equity`), so the sponsor list replaced it.

   False positives (blocking a fund that's actually fine) are acceptable. False negatives aren't.
4. **Sleeve membership** of each holding and proposal is supplied by `portfolio`. `risk` defines the input shape (`sleeve: "core" | "satellite"`). Holdings it can't attribute count as satellite, which is the conservative side of the cap.
5. **Clip, don't reject, when possible.** A buy that exceeds a cap is resized down to fit (2 dp notional) if at least $1 remains. `portfolio` sees the clipped amount and its reason. Proposals are evaluated in the order given, so `portfolio` controls which buys get priority when cash runs short.
6. **Flow-adjusted index.** It starts at 1 on a **base snapshot**: the equity at the close before the first trading day, written with the first snapshot from Alpaca's `last_equity` (and backfilled for the environments live on 2026-11-04 by migration 0018), so day one's return counts. Each step: previous index × (snapshot equity − flows since the previous snapshot) ÷ previous snapshot equity. Flows come from the capital ledger ([SPEC-capital.md](SPEC-capital.md)) and are placed **by instant**: a flow counts at the first snapshot recorded after it. Transfers Alpaca marks `canceled` are left out. The peak is the running max of the index. Live, drawdown steps from the last snapshot with the flows since it, up to when the equity was read. Daily change is measured against the latest snapshot from before today, falling back to Alpaca's `last_equity` (with today's flows) until a snapshot exists.

## Tech Stack

No new dependencies. Asset facts reuse `BrokerAdapter.getAsset` (now also returning `marginRequirementLong`) and `getDailyBars` (120 days, for price, 20-day dollar volume and history length).

## Commands

```sh
npx vitest run risk                                           # (in packages/core) rules, index, gate, state
npm run risk:status  -w @trader/core -- --env staging          # kill switch, halt, drawdown, daily P&L, limits in force
npm run risk:kill    -w @trader/core -- --env staging --reason "…"   # owner: kill switch on
npm run risk:resume  -w @trader/core -- --env staging --reason "…"   # owner: clear kill switch and/or drawdown halt
npm run risk:check   -w @trader/core -- --env staging --buy VTI=50 --buy TQQQ=20   # dry-run proposals against live state; records nothing
```

`--env production` works for `status`, `kill`, `resume` and `check`. Those touch production state, so **you** run them (Claude Code blocks me there anyway). Every owner command is audited with `actor: "owner"` and your `--reason`.

## Project Structure

```
packages/core/src/risk/
  limits.ts     → the owner-set limits + broad-ETF list (code, reviewed via PR)
  rules.ts      → evaluateOrders(): pure, ordered rule pipeline → Decision[]
  index.ts      → flow-adjusted equity index, peak, drawdown, daily change (pure)
  eligibility.ts→ leveraged/inverse, penny/illiquid, IPO, fractionable checks (pure, over AssetFacts)
  state.ts      → risk_state read/write: kill switch, latched halt, owner commands
  gate.ts       → riskGate(): load snapshot → evaluate → persist → audit; checkDrawdown() for sync-broker
packages/core/scripts/risk-{status,kill,resume,check}.ts
```

### Data model (migration `0004`, additive)

| Table | Purpose |
|---|---|
| `risk_state` (single row) | `kill_switch`, `kill_reason`, `halted`, `halt_reason`, `halted_at`, `resumed_at` (the owner's last resume of a halt, which re-bases the drawdown; owner-only, like clearing a halt: migration 0022), `peak_index`, `updated_at`, `updated_by` (`system` / `owner`) |
| `risk_decisions` | One row per evaluated proposal: `evaluated_at`, `gate_run_id`, `intent_key`, `symbol`, `side`, `sleeve`, `requested_notional`/`requested_qty`, `approved_notional`/`approved_qty`, `verdict` (`approved` / `clipped` / `rejected`), `reasons` (jsonb), `limits_version`. Insert-only (added to `APPEND_ONLY_TABLES`). |

### Audit kinds added

`risk.order_clipped`, `risk.order_rejected`, `risk.buys_paused` / `risk.buys_resumed` (daily-loss transitions), `risk.halted`, `risk.kill_switch_on`, `risk.resumed`. `notifications` will email on `risk.halted`, `risk.kill_switch_on`, `risk.buys_paused` and `risk.resumed`. Plain approvals are recorded in `risk_decisions` but not audited, to keep the audit log for things worth reading.

## Code Style

The rule pipeline is a list of small, named, pure functions, each returning a status union. The first rule that rejects wins; clips compose.

```ts
type RuleResult =
  | { kind: "pass" }
  | { kind: "clip"; notional: string; reason: string }
  | { kind: "reject"; reason: string };

const RULES: Rule[] = [killSwitch, drawdownHalt, brokerVerdict, freshData, dailyLossPause,
  noShorting, eligibility, positionCap, sleeveCap, cashAvailable, runawayGuard];
```

Every reason is a sentence a person can read in an email ("TQQQ is leveraged or inverse: ProShares makes leveraged, inverse and volatility funds"), because these reasons become notification text.

## Testing Strategy

- **Rules** (pure, table-driven): each rule's pass, clip and reject paths; the precedence of halts over everything else; sells allowed during a daily-loss pause; clipping below $1 becomes a rejection.
- **Eligibility:** recorded `getAsset` facts for VTI, QQQ, AAPL, TQQQ, SQQQ, SH, SPXL and SOXL, plus a short-term Treasury fund (must pass); penny, illiquid and IPO cases from synthetic bars.
- **Index:** deposits and withdrawals don't move it; a −20% path latches a halt; a recovery doesn't un-latch it; daily change uses `last_equity` before the first snapshot.
- **Gate** (PGlite + fake broker): it persists one decision per proposal, audits clips and rejections, refuses on stale data, and leaves the kill switch and halt state alone. `checkDrawdown` from `sync-broker` trips the halt once and audits once.
- **Owner commands:** kill/resume write `actor: "owner"` events with the reason; resume with nothing to resume is a no-op.

## Boundaries

- **Always:** fail closed (any missing input means reject); persist every decision; make reasons human-readable; keep `evaluateOrders` pure.
- **Ask first:** changing any limit in `limits.ts` (it's your risk tolerance); adding a rule that can block *sells*.
- **Never:** let any `claude`-actor code path change limits, clear a halt or turn off the kill switch; call `submitOrder` except through `riskGate`; let an eligibility rule block an exit.

## Success Criteria

1. Gate green, with every rule in the table covered by pass, clip and reject cases.
2. `risk:check` on staging shows: VTI $50 → approved; TQQQ, SQQQ and SH → rejected (leveraged/inverse); a single stock sized at 30% of equity → clipped to 20%; a buy larger than cash → clipped.
3. `risk:kill` on staging makes every `risk:check` proposal rejected with the kill-switch reason; `risk:resume` restores it. Both write `actor: "owner"` audit events.
4. A simulated −20% index path (test, and a staging DB fixture) latches `halted`. Recovery above the threshold doesn't clear it, and only `risk:resume` does.
5. A deposit recorded between snapshots changes neither drawdown nor daily change (test).
6. Production: migration applied; `risk:status --env production` (you run it) shows no halt, no kill switch and drawdown 0%. `sync-broker` runs the drawdown check each sync. **No orders placed.**

## Resolved Questions (2026-10-31)

1. **Halt scope: freeze everything (Option A).** *Superseded for the drawdown halt by ADR-017 (2026-11-10): closed theses get out. The kill switch still freezes everything.* The kill switch and the −20% drawdown halt both block **all** orders, sells included, until you run `risk:resume`. Neither ever sells on its own. Holdings ride the market like buy-and-hold until a human looks.

   Why: at 70% broad ETFs, a −20% drawdown is almost always a market-wide fall, where holding has historically beaten selling. Freezing also keeps the halted portfolio from behaving worse than its own benchmark (buy-and-hold VTSAX). A single holding collapsing is already bounded by the 20% position cap. The daily −5% pause still allows sells.
2. **`notifications` comes right after `risk`,** so halts and kill-switch events email you before `portfolio` can place an order.
