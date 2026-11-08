# Spec: `agent`

> **Status: Built** (approved and shipped 2026-11-01: #10, #11). SC-1–3 and SC-5 verified; SC-4 (first production strategy before the 9:45 step) is due Monday 2026-11-02. Module 6 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `portfolio` (merged #8). Target: live before Monday 2026-11-02's open, so Claude's first strategy can trade at the 9:45 ET step.

## Objective

Give Claude its seat at the table (ADR-003, ADR-004): a remote **MCP server** where Claude reads the portfolio, researches with its own tools, and **submits strategies**, plus a **scheduled Claude Code routine** that does this autonomously, **pre-market (8:00 ET) and mid-day (12:00 ET) on trading days** (Scott, 2026-11-01; one routine, cron `0 13,17 * * 1-5` UTC). You connect the same server in claude.ai to ask Trader anything: what it holds, why it traded, and what a strategy change would do.

**Claude never gets order tools** (ADR-011). Its only write is `submit_strategy`, which the rebalance job then executes through `risk`. Owner controls (kill switch, resume) stay CLI-only, because the server can't tell your chat apart from the routine.

## Tools

| Tool | Kind | What it gives Claude |
|---|---|---|
| `get_overview` | read | Equity, cash, today's change, drawdown, **vs VTI**, guardrail state (kill switch, halt, buys paused, broker verdict), active strategy version, holdings with sleeve and thesis state |
| `get_strategy` | read | The active strategy (or version N) in full, with each thesis's state (active / stopped / stale, with reasons) and days since it was last reaffirmed |
| `get_holdings` | read | Positions, FIFO lots (average cost, opened), **open wash-sale windows**, and **stopped thesis ids** (which can't be reused) |
| `get_activity` | read | Recent fills and orders, rebalance plans with each trade's reason, `risk` clips and rejections, and strategy submissions (default 14 days) |
| `get_track_record` | read | The thesis scorecard (SPEC-portfolio § Scorecard, 2026-11-07): every thesis ever held, its return on the dollars bought vs the same dollars in VTI, how it ended, days held; rolled up overall and by primary evidence kind |
| `get_prices` | read | Daily adjusted bars for up to 25 symbols (up to 2 years), for Claude's own analysis |
| `check_eligibility` | read | `risk`'s eligibility verdict for up to 25 symbols (leveraged/inverse, price, liquidity, IPO age, fractionable, cap-exempt), so Claude doesn't propose what `risk` will reject |
| `get_rules` | read | The strategy schema with every bound, `risk`'s limits (20% per-name cap, exempt lists, halts, daily pause), the rebalance window and drift rule. The contract Claude writes against |
| `preview_strategy` | read | Validate a draft and run it through the real pipeline (thesis states, ranking, targets, sells-first plan, `risk`) on current data. **Records nothing, orders nothing.** Returns the validation errors, or the trades the next step would make and `risk`'s verdict on each |
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

- **A second Lambda per environment** (`trader-mcp-staging`, `trader-mcp-production`), separate from the engine, so a tool bug can't affect the trading schedule and each has its own IAM. It reads the same SSM secrets plus three MCP ones. It's public through its own Function URL.
- **The auth and protocol are ported from Fred** (`~/fred/src/mcp/auth.ts`, `protocol.ts`; Scott's own code, adapted, and credited in the file headers). They're stateless, so no session store or database tables are needed:
  - **OAuth 2.1** with dynamic client registration (what claude.ai connectors and routines use), a **passphrase consent page**, 1-hour access tokens, 30-day refresh tokens, and audience binding.
  - **A static bearer token** for Claude Code and curl.
  - **Revoking everything** means rotating the signing key.
- **Fails closed:** without a signing key or static token configured, `/mcp` serves nothing.
- **Database access:** `trader_app`, the same as the engine. `submit_strategy` writes as `actor: "claude"`.

### New secrets (SSM, per environment)

| Parameter | What |
|---|---|
| `/trader/<env>/MCP_SIGNING_KEY` | HMAC key for OAuth codes and tokens. Rotating it revokes everything. |
| `/trader/<env>/MCP_PASSPHRASE` | What you type on the consent page when connecting. **This is the security boundary:** make it long and random. |
| `/trader/<env>/MCP_TOKEN` | Optional static bearer token, for Claude Code and curl |

## Assumptions (correct any of these)

1. **The routine's account can reach a custom OAuth connector.** This is the biggest unknown (ADR-004), so it's the **first thing verified** after staging deploys: create the routine against staging and watch one run call `get_overview`. If routines can't attach custom connectors, the fallback is a static-bearer path that I'll find out about then.
2. **Research uses Claude's own web tools.** There are no paid data feeds and no EDGAR integration in v1. A structured EDGAR tool (Form 4, 13F) is a natural follow-up if web research proves thin.
3. **A leaked token's worst case** is someone submitting strategies. Every order still passes `risk`, and every activation emails you. It can't withdraw money or place orders directly. The passphrase and the 1-hour tokens limit the window, and key rotation is the kill switch for access.
4. **Production is the routine's target.** Staging is for building and verifying. You can connect either in claude.ai, as two connectors.

## Commands

```sh
npx vitest run agent                                        # (in packages/core and apps/mcp) tools, previews, auth, protocol
scripts/set-mcp-secrets.sh staging|production [--rotate]    # generate what .env lacks (<ENV>_MCP_*) → SSM; prints names only
curl -s -H "Authorization: Bearer $TOKEN" -X POST $MCP_URL -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Project Structure

```
packages/core/src/agent/      → tool implementations (pure core over Db + Broker): overview, strategy, holdings, activity, prices, eligibility, rules, preview, submit
apps/mcp/                     → trader-mcp Lambda: Function URL adapter, auth (from Fred), protocol (from Fred), tool registry, instructions
infra/lib/engine-stack.ts     → + the MCP function, its URL and its IAM (same SSM path, no SES)
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
