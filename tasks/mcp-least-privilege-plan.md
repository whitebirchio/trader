# Plan: least privilege for the MCP server (review finding R1)

> **Status: Approved** (Scott, 2026-11-08: build and verify on staging now; production cut-over after Monday's 8:08 run). Found in the codebase review. Paired with R2 (migration 0021, "only the owner resumes"), which already removes a leaked credential's power to clear a halt.

## Why
The MCP Lambda is public, behind its own OAuth, and today it reads the whole `/trader/<env>/` SSM path (`infra/lib/engine-stack.ts:162`). So it holds **Alpaca's trading-capable keys** and **`trader_app`'s database URL**. ADR-011 ("no order tools for Claude") holds at the tool layer, but one auth bug or one remote-code-execution flaw in a dependency would allow direct orders at Alpaca (bypassing risk) and writes to most tables.

## What the MCP server actually needs (read 2026-11-08)
- **Alpaca:** only `getDailyBars`, `getAsset` and `getCalendar`, all market data and reference data. Every tool reads the account, positions and orders from the database mirror, and `preview_strategy` is a dry run that never submits.
- **Database:** `SELECT`, plus `INSERT` into `strategies` (and its `version` sequence) and `audit_events`. Those are `submit_strategy`'s only writes; `preview_strategy` records nothing.

## Design
1. **A market-data-only Alpaca key for the MCP server.**
   - **Production:** the MCP server uses the **paper account's** keys, which see the same market data, assets and calendar, so the production MCP Lambda holds **no live-account credential**. `AlpacaBroker` picks its host from `TRADING_ENV`, so give it a separate `dataEnv` (`paper`) for the MCP server; the engine is unchanged.
   - **Staging:** it already uses paper keys, so nothing changes there.
   - **Check:** the MCP server never calls a trading endpoint. A test fails if `ToolDeps.broker` is asked for `getAccount`, `getPositions`, `getOrders`, `submitOrder` or `updateAccountConfig`.
2. **A `trader_mcp` database role** (`scripts/mcp-role.ts`, modelled on `app-role.ts` and `dashboard-role.ts`):
   - `SELECT` on all tables;
   - `INSERT` on `strategies` and `audit_events` only, plus `USAGE` on `strategies_version_seq`;
   - no `UPDATE`, `DELETE` or `TRUNCATE` anywhere, and no DDL;
   - a `--check` mode proves the denials, like `db:dashboard-role -- --check`.
3. **The MCP server's own secrets.** Its role reads an explicit list of parameters, not the whole path:
   - `MCP_DATABASE_URL` (as `trader_mcp`);
   - `MCP_ALPACA_KEY_ID` and `MCP_ALPACA_SECRET_KEY` (the paper data key);
   - `MCP_TOKEN`, `MCP_PASSPHRASE` and `MCP_SIGNING_KEY`.
   
   `apps/mcp` loads those names with `GetParameters`. An infra test pins the policy: no `ALPACA_*` and no `DATABASE_URL` for the MCP role.
4. **Docs:** SPEC-agent's "reads the same SSM secrets" becomes the least-privilege layout, and ADR-011 gets a note that the credential layer now matches the tool layer.

## Tasks
- [x] L1: The `trader_mcp` role script with `--check` (it proves its grants as the role against Neon; PGlite has no login roles to test it against).
- [x] L2: `apps/mcp` loads its own parameter names (`MCP_PARAMETERS` in core); `MarketDataOnly` wraps a paper-host `AlpacaBroker`; a test runs every tool through it.
- [x] L3: Infra: the MCP role's explicit parameter list (`ssm:GetParameters`); infra tests pin it.
- [ ] L4: **Owner steps (Scott runs; production secrets are "ask first"):**
  - `npm run db:mcp-role` for staging, then production;
  - `scripts/set-mcp-secrets.sh <env>` extended to write `MCP_DATABASE_URL` and the paper data key to SSM.
  
  The deploy order matters: secrets first, then merge, so the new MCP function finds them.
- [ ] L5: Staging: the routine's tools work end to end through the staging connector (a preview and a read of every tool); the MCP role's `--check` passes. Then production the same way, before Monday's 8:08 run, or after it if we'd rather not change anything the routine touches tonight.

## Risks
| Risk | Mitigation |
|---|---|
| A tool needs something the narrower role or key can't do, and the routine fails mid-run | L5 exercises every tool on staging first; the deploy waits until the secrets exist; rollback is reverting the infra change |
| Paper and live data differ (assets, calendar) | Both come from Alpaca's same reference data; eligibility already uses `getAsset` facts that don't depend on the account |
| Changing what the routine uses right before Monday's first run under the new rules | Do L4–L5 for production after Monday's run, unless you want it tonight |
