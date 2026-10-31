# Tasks: `risk`

> Plan: [risk-plan.md](risk-plan.md) · Spec: [SPEC-risk.md](../SPEC-risk.md)
> **gate** = `npm run typecheck && npm test`. Work happens on `risk/*` branches, so pushes deploy **staging** only.

## Phase 1: Pure engine

### R1: Limits, types, eligibility
- **Acceptance:**
  - [x] `risk/limits.ts`: every number in the spec's limits table, plus the broad-ETF list; `limitsVersion()` hash
  - [x] Types: `Proposal` (intent key, symbol, side, sleeve, notional or qty), `RiskSnapshot`, `AssetFacts`, `Decision`
  - [x] `getAsset` returns `marginRequirementLong` (adapter + fixture + fake broker)
  - [x] `eligibility.ts`: leveraged/inverse (margin ≥ 50 OR name pattern), penny (< $5), illiquid (20-day ADV < $10M), IPO (< 90 days of bars), not tradable / not fractionable. Each returns a readable reason.
  - [x] Tests against recorded assets: VTI, QQQ, AAPL, XLK, ARKK pass; TQQQ, SQQQ, SH, SPXL, UVXY, SOXL rejected; a "Short-Term Treasury" fund passes
- **Verify:** `npx vitest run risk/eligibility`; gate
- **Depends on:** — · **Files:** `src/risk/{limits,types,eligibility}.ts`, `src/broker/{port,alpaca}.ts`, tests + fixtures · **Scope:** M

### R2: Flow-adjusted equity index
- **Acceptance:**
  - [x] `buildIndex(snapshots, flows)` → daily index, running peak, drawdown; `liveIndex(state, equityNow, flowsToday, lastEquity)` → current drawdown and daily change
  - [x] Flows = `CSD`, `CSW`, `JNLC`, `JNLS` net amounts by market date
  - [x] Tests: a deposit or withdrawal between snapshots doesn't move the index; a −20% path; recovery after a new peak; no snapshots yet (uses `last_equity`)
- **Verify:** `npx vitest run risk/index`; gate
- **Depends on:** — · **Files:** `src/risk/equity-index.ts` (renamed from the plan's `index.ts` so it can't be mistaken for a barrel file), test · **Scope:** S

### R3: `evaluateOrders`
- **Acceptance:**
  - [x] Rule pipeline in spec order: kill switch → drawdown halt → broker verdict → fresh data → daily-loss pause (buys) → no shorting (clip sells) → eligibility (buys) → position cap (non-broad, 20%) → sleeve cap (satellite, 30%) → cash (minus buffer) → runaway guard
  - [x] Clips compose; a remainder under $1 becomes a reject; proposals are evaluated in order, consuming cash and caps as they go
  - [x] Sells pass eligibility, caps and the daily-loss pause; the kill switch and halt block sells
  - [x] Table-driven tests: pass/clip/reject for every rule, plus precedence
- **Verify:** `npx vitest run risk/rules`; gate
- **Depends on:** R1, R2 · **Files:** `src/risk/rules.ts`, test · **Scope:** M

### Checkpoint A
- [x] Gate green
- [ ] Scott skims a sample of rejection/clip reasons (printed in the PR description)

## Phase 2: State, gate, sync hook

### R4: Migration 0004 + state
- **Acceptance:**
  - [x] Tables: `risk_state` (singleton, seeded by migration 0005; peak is recomputed from snapshots, not stored), `risk_gate_runs` (snapshot jsonb, limits_version), `risk_decisions`; the last two are in `APPEND_ONLY_TABLES`, with triggers and guarded revokes
  - [x] `state.ts`: `getRiskState`, `setKillSwitch(on, reason, actor: "owner")`, `latchHalt(reason)` (conditional, once), `resume(reason, actor: "owner")`; each audits
  - [x] Tests: latch once under concurrency; resume clears both; resume with nothing set is a no-op; no claude-actor path exists (type-level: `actor: "owner"` only)
- **Verify:** `npx vitest run risk/state append-only db`; `db:generate` clean; gate
- **Depends on:** — · **Files:** `src/db/schema.ts`, `drizzle/0004_*`, `drizzle/0005_*`, `src/risk/state.ts`, `src/audit.ts`, tests · **Scope:** M

### R5: `riskGate` + `checkDrawdown`
- **Acceptance:**
  - [x] `riskGate(db, broker, env, proposals, now)`: builds the `RiskSnapshot` from DB (`broker_account`, `positions`, `equity_snapshots`, `broker_activities`, `risk_state`, today's `orders`) plus asset facts from the broker; evaluates; inserts one `risk_gate_runs` row and one `risk_decisions` row per proposal; audits clips and rejections
  - [x] `checkDrawdown(db, now)` called at the end of `sync-broker`: latches the halt at ≤ −20%; emits `risk.buys_paused` / `risk.buys_resumed` on daily-loss transitions; an error here never undoes the sync
  - [x] Tests (PGlite + fake broker): stale sync rejects all; decisions persisted; halt trips and audits once across repeated syncs; daily-loss transitions audited once each way
- **Verify:** `npx vitest run risk/gate broker/sync`; gate
- **Depends on:** R3, R4 · **Files:** `src/risk/gate.ts`, `src/jobs.ts`, tests; plus migration 0006 adding `broker_account.last_equity` (the daily-loss base), written by `sync-broker` · **Scope:** M

### Checkpoint B
- [x] Gate green · `db:generate` clean · push (staging migrates)

## Phase 3: Operate and ship

### R6: Owner scripts + docs
- **Acceptance:**
  - [ ] `risk:status`, `risk:kill --reason`, `risk:resume --reason`, `risk:check --buy SYM=N --sell SYM=N [--sleeve satellite]`, all with `--env staging|production`; `check` is a dry run (`evaluateOrders` on a live snapshot, nothing recorded)
  - [ ] `docs/SETUP.md` "Risk controls" section; `CLAUDE.md` architecture line; ADR-012 "Halts freeze everything; only the owner resumes"
- **Verify:** run all four against staging
- **Depends on:** R5 · **Files:** `scripts/risk-*.ts`, `package.json`, docs · **Scope:** S

### R7: Verify and ship
- **Acceptance:**
  - [ ] SC-2: `risk:check` on staging: VTI $50 approved; TQQQ/SQQQ/SH rejected; a 30% single-stock buy clipped to 20%; a buy larger than cash clipped
  - [ ] SC-3: `risk:kill` → all rejected; `risk:resume` → restored; both `actor: "owner"`
  - [ ] SC-4/SC-5 covered by tests (and a staging fixture for the halt)
  - [ ] PR → production; *(Scott)* `risk:status --env production` shows no halt, no kill switch, drawdown 0%
- **Depends on:** R6 · **Scope:** S

### Checkpoint C
- [ ] All 6 success criteria checked · Scott reviews · next: `SPEC-notifications.md`
