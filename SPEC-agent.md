# Spec: `agent`

> **Status: Built** (approved and shipped 2026-11-01: #10, #11). SC-1–3 and SC-5 verified; SC-4 (first production strategy before the 9:45 step) is due Monday 2026-11-02. Module 6 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `portfolio` (merged #8). Target: live before Monday 2026-11-02's open, so Claude's first strategy can trade at the 9:45 ET step.

## Objective

Give Claude its seat at the table (ADR-003, ADR-004): a remote **MCP server** where Claude reads the portfolio, researches with its own tools, and **submits strategies**, plus a **scheduled Claude Code routine** that does this autonomously, **pre-market (8:00 ET) and mid-day (12:00 ET) on trading days** (Scott, 2026-11-01; one routine, cron `0 13,17 * * 1-5` UTC). You connect the same server in claude.ai to ask Trader anything: what it holds, why it traded, and what a strategy change would do.

**Claude never gets order tools** (ADR-011). Its only write that reaches the market is `submit_strategy`, which the rebalance job then executes through `risk`. Its other write, `update_watchlist` (#32), keeps research notes and has no trading effect. Owner controls (kill switch, resume) stay CLI-only, because the server can't tell your chat apart from the routine.

## Tools

| Tool | Kind | What it gives Claude |
|---|---|---|
| `get_overview` | read | Equity, cash, today's change, drawdown, **vs VTI**, guardrail state (kill switch, halt, buys paused, broker verdict), active strategy version, holdings with sleeve and thesis state |
| `get_strategy` | read | The active strategy (or version N) in full, with each thesis's state (active / stopped / stale, with reasons) and days since it was last reaffirmed; each thesis's `reviewBy` and `daysToReview` (2026-11-08, #35) |
| `get_holdings` | read | Positions, FIFO lots (average cost, opened), **open wash-sale windows**, **stopped thesis ids** (which can't be reused), and **each held thesis's sell-side signals** (exits plan T2): return since its first lot against VTI, the high since and the distance from it, the stop price and the distance above it, any earnings reaction since entry, `check_eligibility`'s screens, and `flags` (`earnings_crash_since_entry`, `recent_big_loser`, `near_stop` within 5%, `lagging_vti` by 10+ points). Informational: code doesn't sell on them; the routine re-judges each thesis every run |
| `get_activity` | read | Recent fills and orders, rebalance steps that traded (one line per trade, with its reason and `risk`'s verdict), `risk` clips and rejections, and strategy submissions by version and headline (default 14 days). Steps that planned nothing are counted, with their notes once each; the full strategy is `get_strategy`'s (#74) |
| `get_track_record` | read | The thesis scorecard (SPEC-portfolio § Scorecard, 2026-11-07): every thesis ever held, its return on the dollars bought vs the same dollars in VTI, how it ended, days held; rolled up overall and by primary evidence kind |
| `get_prices` | read | Daily adjusted bars for up to 25 symbols (up to 2 years), for Claude's own analysis |
| `check_eligibility` | read | `risk`'s eligibility verdict for up to 25 symbols (leveraged/inverse, price, liquidity, IPO age, fractionable, cap-exempt), so Claude doesn't propose what `risk` will reject; per symbol, `signals` (2026-11-08, #54): the 12-1 month return (`recentBigLoser` at −30%) and the last earnings reaction from SEC filings (`freshEarningsCrash` at −10% within 10 sessions), fail-soft if SEC can't be read |
| `get_exposure` | read | Concentration (2026-11-08, #31): each holding's weight, SEC industry (SIC) and an approximate sector; sector weights (VTI is the broad market); 60-session daily-return correlations among single names, listing pairs at 0.5 or more with `oneBet` at 0.7 or more, and each name vs VTI. Active theses not bought yet and up to 25 given candidates are measured too. Fail-soft if SEC can't be read |
| `get_rules` | read | The strategy schema with every bound, `risk`'s limits (20% per-name cap, exempt lists, halts, daily pause), the rebalance window and drift rule. The contract Claude writes against |
| `preview_strategy` | read | Validate a draft and run it through the real pipeline (thesis states, ranking, targets, sells-first plan, `risk`) on current data. **Records nothing, orders nothing.** Returns the validation errors, or the trades the next step would make and `risk`'s verdict on each, plus `warnings` (2026-11-08, #60: any thesis without a `plainSummary`) |
| `get_watchlist` | read | *(#32, 2026-11-11)* Claude's research memory across runs: the open names (soonest revisit first) with why, the trigger that would make each a thesis, `revisitBy`, `due` once past it, and `nowThesis` if it's already in the strategy; plus drops in the last 14 days. `get_overview` carries `watchlist: { open, due }` |
| *(earnings, #30, 2026-11-11)* | | `get_holdings` (each held thesis) and `check_eligibility` (each symbol) carry `nextEarnings`: the next scheduled report on or after today (`date`, `inDays`, `timeOfDay`, the consensus `estimate`), from the latest daily snapshot of Alpha Vantage's three-month calendar (`earnings_calendar`, refreshed by the `earnings-calendar` tick job, one request a day, a week kept). A held thesis reporting within 7 days is flagged `earnings_soon`, which isn't a sell signal. `get_holdings`' `earningsCalendar` gives the snapshot's date, with a note when it's missing or over 3 days old. Optional key `ALPHAVANTAGE_API_KEY` in SSM; without it the job skips |
| `update_watchlist` | **write** | *(#32)* A batch of up to 25 changes, all or nothing: `watch` (why 10–600 characters, trigger 10–400, `revisitBy` after today and within 120 days; watching again replaces the note) or `drop` (why; the name must be open). At most 40 open names. Insert-only rows in `watchlist_notes` (actor `claude`), one `watchlist.updated` audit event per batch, reported in the daily digest's "Research watchlist" section. **No trading effect** |
| `submit_strategy` | **write** | Validate and store the draft as the next version (`actor: claude`). On success it's active from the next rebalance step and emails you (`strategy.activated`). On failure the old version stays and you're emailed the errors |

**Server instructions** (sent at `initialize`) tell Claude how the system works and what's expected of it:
- research first;
- every thesis needs evidence and a stop-loss;
- preview before submitting;
- **reaffirm by resubmitting**, since theses go stale after 30 days;
- weigh wash-sale windows;
- idle money sits in VTI;
- this is risk capital, and the goal is an edge over VTI.

## The routine

A **Claude Code scheduled routine** in your claude.ai account, with the Trader production connector attached.
- **When:** weekdays at 8:00 and 12:00 ET (one routine, two fire times). On market holidays, Claude sees from `get_overview` that the market is closed and does no trading research.
- **What it runs:** a checked-in prompt, `agent/routine-prompt.md`, versioned with the code.
- **Each run, Claude:**
  1. Reads `get_overview`, `get_strategy`, `get_holdings` and `get_activity`.
  2. Researches with its own web tools. Sources: Congress trade disclosures (STOCK Act filings and aggregator sites), SEC EDGAR Form 4 insider buys and 13F holdings (e.g. Berkshire Hathaway), earnings, guidance and news for current and candidate names.
  3. Decides: **add** a thesis, **change** (resize or replace theses), **exit** a thesis, or **keep** (resubmit unchanged, which reaffirms the theses). Since ADR-016 the stance is aggressive but evidence-based: most of the account in 5–8 theses, a few trades a week, the systematic sleeve idle-only (VTI).
  4. Runs `preview_strategy`, then `submit_strategy`.
- **If the routine stops running,** the last strategy keeps executing. After 30 days without a resubmission, theses unwind to systematic and you're emailed (ADR-004, ADR-013).

## Architecture

```
claude.ai connector (you)  ┐
Claude Code routine (cron) ┴─▶ trader-mcp-<env> Lambda (Function URL)
                                 OAuth 2.1 (stateless HMAC, DCR, passphrase consent) · static bearer
                                 MCP Streamable HTTP, stateless JSON-RPC
                                 tools → @trader/core (store, rebalance dry-run, risk, broker reads)
```

- **A second Lambda per environment** (`trader-mcp-staging`, `trader-mcp-production`), separate from the engine, so a tool bug can't affect the trading schedule and each has its own IAM. It's public through its own Function URL.
- **Least privilege (codebase review finding R1, 2026-11-08):** the MCP function reads only its own named parameters (`MCP_PARAMETERS` in core; IAM `ssm:GetParameters` on exactly those), never the engine's `DATABASE_URL` or Alpaca keys.
  - **Its Alpaca client is market-data-only** (`MarketDataOnly`: bars, assets, calendar; every account and order method throws), on the **paper** hosts with the paper account's key in both environments. So production's public MCP function holds no live-account credential. Every tool runs on that alone (tested).
  - **Its database role is `trader_mcp`** (`scripts/mcp-role.ts`): `SELECT`, plus `INSERT` on `strategies` and `audit_events` (submit_strategy's writes), and on `watchlist_notes` (update_watchlist's, #32; granted by migration 0023 too). ADR-011's rule (no order tools) now holds at the credential layer as well as the tool layer.
- **The auth and protocol are ported from Fred** (`~/fred/src/mcp/auth.ts`, `protocol.ts`; Scott's own code, adapted, and credited in the file headers). They're stateless, so no session store or database tables are needed:
  - **OAuth 2.1** with dynamic client registration (what claude.ai connectors and routines use), a **passphrase consent page**, 1-hour access tokens, 30-day refresh tokens, and audience binding.
  - **Stateless trade-offs, accepted (codebase review, 2026-11-08):** with no server-side store, an authorization code can be redeemed more than once within its 5-minute life, and an earlier refresh token stays valid until it expires. PKCE means a stolen code is useless without the client's verifier, access tokens last an hour, and rotating `MCP_SIGNING_KEY` revokes everything at once. The passphrase page sends a `frame-ancestors 'none'` CSP, so it can't be framed.
  - **A static bearer token** for Claude Code and curl.
  - **Revoking everything** means rotating the signing key.
- **Fails closed:** without a signing key or static token configured, `/mcp` serves nothing.
- **Database access:** `trader_mcp` (above). `submit_strategy` writes as `actor: "claude"`.

### New secrets (SSM, per environment)

| Parameter | What |
|---|---|
| `/trader/<env>/MCP_SIGNING_KEY` | HMAC key for OAuth codes and tokens. Rotating it revokes everything. |
| `/trader/<env>/MCP_PASSPHRASE` | What you type on the consent page when connecting. **This is the security boundary:** make it long and random. |
| `/trader/<env>/MCP_TOKEN` | Optional static bearer token, for Claude Code and curl |
| `/trader/<env>/MCP_DATABASE_URL` | `trader_mcp`'s connection string (created or rotated by `set-mcp-secrets.sh`) |
| `/trader/<env>/MCP_ALPACA_KEY_ID`, `MCP_ALPACA_SECRET_KEY` | The **paper** account's key, for market data, in both environments |

## Assumptions (correct any of these)

1. **The routine's account can reach a custom OAuth connector.** This is the biggest unknown (ADR-004), so it's the **first thing verified** after staging deploys: create the routine against staging and watch one run call `get_overview`. If routines can't attach custom connectors, the fallback is a static-bearer path that I'll find out about then.
2. **Research uses Claude's own web tools.** There are no paid data feeds and no EDGAR integration in v1. A structured EDGAR tool (Form 4, 13F) is a natural follow-up if web research proves thin.
3. **A leaked token's worst case** is someone submitting strategies. Every order still passes `risk`, and every activation emails you. It can't withdraw money or place orders directly. The passphrase and the 1-hour tokens limit the window, and key rotation is the kill switch for access.
4. **Production is the routine's target.** Staging is for building and verifying. You can connect either in claude.ai, as two connectors.

## Commands

```sh
npx vitest run agent                                        # (in packages/core and apps/mcp) tools, previews, auth, protocol
scripts/set-mcp-secrets.sh staging|production [--rotate]    # generate what .env lacks (<ENV>_MCP_*), create/rotate trader_mcp, copy the paper data key → SSM; prints names only
DATABASE_URL=<owner url> MCP_DATABASE_URL=<its url> npm run db:mcp-role -w @trader/core -- --check   # prove trader_mcp's grants without rotating
curl -s -H "Authorization: Bearer $TOKEN" -X POST $MCP_URL -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Project Structure

```
packages/core/src/agent/      → tool implementations (pure core over Db + Broker): overview, strategy, holdings, activity, prices, eligibility, rules, preview, submit
apps/mcp/                     → trader-mcp Lambda: Function URL adapter, auth (from Fred), protocol (from Fred), tool registry, instructions
infra/lib/engine-stack.ts     → + the MCP function, its URL and its IAM (its own named MCP_* parameters, no SES)
agent/routine-prompt.md       → the routine's prompt (checked in)
```

## Testing Strategy

- **Tools (core, PGlite + fake broker):** each read tool's shape. `preview_strategy` matches what `runRebalance` would do (same functions, dry run) and records nothing. `submit_strategy` activates (actor `claude`) or rejects, and audits either way. `check_eligibility` matches `risk`'s.
- **Auth (ported tests):** DCR, PKCE, wrong passphrase, expired or wrong-audience tokens, static bearer, fails closed when unconfigured.
- **Protocol:** `initialize`, `tools/list`, `tools/call`, notifications → 202, GET/DELETE → 405, bad JSON → a JSON-RPC error.
- **Live:**
  - connect staging in claude.ai, preview and submit on paper;
  - one routine run against staging, then switch the routine to production;
  - production `get_overview` matches `risk:status`.

## Boundaries

- **Always:** fail closed; every write goes through `submitStrategy`'s validation; tool output is plain and current (no cached numbers); the routine prompt is checked in.
- **Ask first:** any new write tool; letting the routine run anywhere but production; paid data sources.
- **Never:** order, cancel or kill-switch tools over MCP; exposing secrets or full account numbers in tool output; a routine that can bypass `preview` and `risk`.

## Success Criteria

1. Gate green (core tools, MCP auth and protocol, infra assertions).
2. Staging: you connect `trader-mcp-staging` in claude.ai with the passphrase. `get_overview` matches `risk:status --env staging`. `preview_strategy` on a sample conviction strategy shows sells-first trades and `risk` verdicts. `submit_strategy` activates v1 on paper and you get the email (production-style emails only from production; staging stays quiet except tests).
3. **The routine runs once against staging,** calls the tools and submits (or reaffirms) a strategy, with its run visible in `get_activity`.
4. Production: `trader-mcp-production` deployed and connected. The routine is switched to production on weekday 8:00 and 12:00 ET. **The first production strategy from Claude is active before the 9:45 ET step** (Monday, if timing allows; otherwise the next trading day).
5. No order-placing path exists outside `rebalance` → `risk` → `submitOrder`, which tests pin by checking the tool list.

## Open Questions

1. **The consent passphrase:** resolved. Random, generated by `set-mcp-secrets.sh` into `.env` (`<ENV>_MCP_PASSPHRASE`) and SSM, never printed (Scott, 2026-11-01).
2. **The routine's identity:** resolved. Created with the schedule tooling in your account (Scott, 2026-11-01). Opus 5.5, staging first, then switched to the production connector.
