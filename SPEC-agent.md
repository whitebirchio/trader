# Spec: `agent`

> **ADR-018 (2026-11-11): staging is retired.** Production is the only deployed environment. Where this spec runs a command with `--env staging`, paper work now uses `--env paper` (the paper account on a local database), and checks of the deployed system use `--env production`. Records of what was checked on staging stay as written.

> **Status: Built** (approved and shipped 2026-11-01: #10, #11). SC-1–3 and SC-5 verified; SC-4 (first production strategy before the 9:45 step) is due Monday 2026-11-02. Module 6 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `portfolio` (merged #8). Target: live before Monday 2026-11-02's open, so Claude's first strategy can trade at the 9:45 ET step.

## Objective

Give Claude its seat at the table (ADR-003, ADR-004): a remote **MCP server** where Claude reads the portfolio, researches with its own tools, and **submits strategies**, plus a **scheduled Claude Code routine** that does this autonomously, **pre-market (8:00 ET) and mid-day (12:00 ET) on trading days** (Scott, 2026-11-01; one routine, cron `0 13,17 * * 1-5` UTC). You connect the same server in claude.ai to ask Trader anything: what it holds, why it traded, and what a strategy change would do.

**Claude never gets order tools** (ADR-011). Its only write that reaches the market is `submit_strategy`, which the rebalance job then executes through `risk`. Its other writes, `update_watchlist` (#32, research notes) and `record_lesson` (#28, post-mortems on closed theses), have no trading effect. Owner controls (kill switch, resume) stay CLI-only, because the server can't tell your chat apart from the routine.

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
| `preview_strategy` | read | Validate a draft and run it through the real pipeline (thesis states, ranking, targets, sells-first plan, `risk`) on current data. **Records nothing, orders nothing.** Returns the validation errors, or the trades the next step would make and `risk`'s verdict on each, plus `warnings` (2026-11-08, #60: any thesis without a `plainSummary`; 2026-11-12, #106: any without a `bearCase`, which is an error instead on a new thesis or a raised weight) |
| `get_watchlist` | read | *(#32, 2026-11-11)* Claude's research memory across runs: the open names (soonest revisit first) with why, the trigger that would make each a thesis, `revisitBy`, `due` once past it, and `nowThesis` if it's already in the strategy; plus drops in the last 14 days. `get_overview` carries `watchlist: { open, due }` |
| *(earnings, #30, 2026-11-11)* | | `get_holdings` (each held thesis) and `check_eligibility` (each symbol) carry `nextEarnings`: the next announced report on or after today (null until the company announces a date, usually two to four weeks ahead; the three-month calendar is sparse beyond that) (`date`, `inDays`, `timeOfDay`, the consensus `estimate`), from the latest daily snapshot of Alpha Vantage's three-month calendar (`earnings_calendar`, refreshed by the `earnings-calendar` tick job, one request a day, a week kept). A held thesis reporting within 7 days is flagged `earnings_soon`, which isn't a sell signal. `get_holdings`' `earningsCalendar` gives the snapshot's date, with a note when it's missing or over 3 days old. Optional key `ALPHAVANTAGE_API_KEY` in SSM; without it the job skips |
| *(filings, #105, 2026-11-11)* | | The hourly `check-filings` tick job reads SEC EDGAR for every thesis and open watchlist name: Form 4, Form 144, 8-K (by item), Schedule 13D/13G, 10-Q and 10-K from the last 30 days. It stores each new one in `sec_filings` (a cache, 180 days kept) with a plain summary, parsing Form 4s (open-market sales and purchases, officer or director, 10b5-1) and Form 144s, and reading each item 5.02 8-K for a departure. `get_holdings` gives each held thesis's `filings` since its first buy, and `get_watchlist` each name's since it went on the list (newest first, 10 at most, non-trade Form 4s left out), with `filingsCheck` (when the last check finished; a note past 3 hours). Two are sell signals and flag the thesis: `insider_selling` (an officer or director sold on the open market outside a 10b5-1 plan) and `executive_departure`. On a held name, either emails the owner at once (`filing.sell_signal`). Every other new filing from the last 3 days goes in the digest (`filings.noticed`). Informational: code doesn't sell on them. Free, no key; a 2-minute budget per run |
| *(earnings history, #105, 2026-11-11)* | | The `earnings-backfill` tick job fills `earnings_history` from Alpha Vantage's free `EARNINGS` endpoint: each company's quarterly reported vs. estimated EPS, surprise and report date, from 2017 on. That's one request per company, so it goes slowly: at most 3 a tick and a daily budget of 20 (the free key allows 25 a day, and the calendar takes one). Theses and open watchlist names come first, then the 2,679 companies of the earnings-reaction backtest (`EARNINGS_UNIVERSE`, in SHA-256 order of ticker, so what's stored is always a random sample). A skipped run's reason carries the running total. Each company is asked for once (`earnings_history_fetches`); a failure is retried on a later day, and after Alpha Vantage refuses a request for the daily limit the job waits for the next market date (a refusal for going faster than one a second only ends that run). Data for the earnings-surprise backtest; no tool reads it yet. Re-fetching a company after its next report is a follow-up |
| *(estimate revisions, #105, 2026-11-12)* | | The `earnings-estimates` tick job fetches Alpha Vantage's free `EARNINGS_ESTIMATES` for every thesis and open watchlist name: theses first, each about every 7 days, at most 1 request a tick and 3 a day. It runs before the backfill, so the day's requests go to held names first; with the calendar's 1 and the backfill's 20, the free 25 hold. Each fetch is a row in `earnings_estimates`, kept so that a history builds up; the source has only today's snapshot. A row holds the first fiscal quarter and fiscal year dated after today, because the source's past periods can be mislabeled. `get_holdings` gives each held thesis's `estimates`, and `get_watchlist` each name's: the consensus EPS, its change over 30 and 90 days, analysts raising and cutting over 30 days, and the analyst count. A held thesis is flagged `estimates_falling` when either consensus fell 3% or more in 30 days. That's something to weigh, not a sell signal: it hasn't been backtested here. A failed fetch is retried the next day. After a daily-limit refusal from either Alpha Vantage job, both wait for the next market date |
| `update_watchlist` | **write** | *(#32)* A batch of up to 25 changes, all or nothing: `watch` (why 10–600 characters, trigger 10–400, `revisitBy` after today and within 120 days; watching again replaces the note) or `drop` (why; the name must be open). At most 40 open names. Insert-only rows in `watchlist_notes` (actor `claude`), one `watchlist.updated` audit event per batch, reported in the daily digest's "Research watchlist" section. **No trading effect** |
| `record_lesson` | **write** | *(#28, 2026-11-12, approved by Scott)* A post-mortem on a closed thesis: what was expected, what happened, what to do differently. A batch of 1–10, all or nothing. `get_track_record` gains each closed row's `lesson` and `lessonsDue`; `check_eligibility` gains `pastLessons`; `get_rules` a `lessons` section. Insert-only rows in `thesis_lessons` with the outcome frozen, one `lessons.recorded` audit event, reported in the digest. **No trading effect** (§ Lessons) |
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
- **When:** weekdays at 8:00 and 12:00 ET. On market holidays, Claude sees from `get_overview` that the market is closed and does no trading research.
- **Two routines, one prompt** *(2026-11-12)*. The 8:00 full review runs on Opus; the 12:00 check of what changed runs on Sonnet, to stretch the account's weekly usage limit. Both send the same stub and read the same prompt. `agent/routines.json` records each one's trigger, cron (UTC) and model: to change a model or a time, edit it, merge, and have Claude Code apply it with RemoteTrigger (CI has no credential for the routines API). A test keeps the missed-run alert's fire times (`ROUTINE_RUNS_UTC`) in step with its crons.
- **What it runs:** a checked-in prompt, `agent/routine-prompt.md`, versioned with the code. *(2026-11-12, #118)* The routine stores only a stub (`agent/routine-stub.md`): each run fetches `main` in its checkout and reads the prompt from it (`git show origin/main:agent/routine-prompt.md`), so a prompt change ships with its merge and needs no update to the routine. If it can't read `origin/main` it reads the checkout's copy, and if neither reads it stops without submitting. Its report ends with the commit it read. A run that starts during a deploy can read a prompt a few minutes ahead of the tools; it trusts the tools. The stub changes only when the loading steps do, and then needs a RemoteTrigger update.
- **Each run, Claude:**
  1. Reads `get_overview`, `get_strategy`, `get_holdings` and `get_activity`.
  2. Researches with its own web tools. Sources: Congress trade disclosures (STOCK Act filings and aggregator sites), SEC EDGAR Form 4 insider buys and 13F holdings (e.g. Berkshire Hathaway), earnings, guidance and news for current and candidate names.
  3. Decides: **add** a thesis, **change** (resize or replace theses), **exit** a thesis, or **keep** (resubmit unchanged, which reaffirms the theses). Since ADR-016 the stance is aggressive but evidence-based: most of the account in 5–8 theses, a few trades a week, the systematic sleeve idle-only (VTI).
  4. Runs `preview_strategy`, then `submit_strategy`.
- **If the routine stops running,** the last strategy keeps executing. After 30 days without a resubmission, theses unwind to systematic and you're emailed (ADR-004, ADR-013).
- **A missed run is emailed** *(2026-11-12)*. Every run on a trading day submits a strategy, unchanged or not. The `check-routine` tick job looks 45 minutes after each fire time (13:00 and 17:00 UTC, `ROUTINE_RUNS_UTC` in `src/agent/routine-watch.ts`, which must match the trigger's cron; #14). If Claude submitted nothing, activated or rejected, between that fire time and the next, it records `routine.missed` once (urgent), and the same tick's `notify-urgent` sends it. A holiday has no runs to miss. It catches a run stopped by the account's weekly usage limit, which skipped two runs in November 2026 with no one told. *(2026-11-13)* With routine tokens set, it re-fires the run first (§ Missed-run recovery).

## Lessons

*(2026-11-12, #28; the write tool approved by Scott the same day. Plan: `tasks/lessons-plan.md`.)*

`get_track_record` scores each thesis but doesn't say why it won or lost, and each run starts cold. When a thesis closes, the next run writes a post-mortem, and later runs read it before deciding on the same stock or the same kind of signal. The bear case argues before buying; the lesson checks the argument after selling.

- **When:** a thesis is due a lesson once its scorecard row is closed (`closedAt`: flat after the thesis left), however it ended. `get_track_record`'s `lessonsDue` lists them, each with the last strategy version that listed it.
- **What:** `expected` (the thesis as written: its reason and why the market was wrong), `happened` (the outcome and what drove it), `lesson` (what to do differently, or why it was luck). 20–600 characters each.
- **Stored:** `thesis_lessons`, insert-only (the `reject_mutation` triggers; `trader_mcp` gets `INSERT` only). Each row freezes the outcome it was judged against: ending, days held, return, VTI's and the excess. A later lesson on the same thesis replaces it; rows never change.
- **Rejected:** an unknown thesis id, a thesis still active or still holding shares, a duplicate in the batch, text out of bounds. The whole batch is refused.
- **Read back:** each closed `get_track_record` row carries its `lesson`. `check_eligibility` carries `pastLessons` for each symbol (the latest lesson for each past thesis on it, newest first, up to 3).
- **The owner:** `lessons.recorded` routes to the digest, under "Lessons".
- **The routine:** writes a lesson for every `lessonsDue` thesis in Orient, and reads `pastLessons` and same-signal lessons before drafting. A lesson from a hold of days is weak evidence.

## Missed-run recovery (2026-11-13)

> **Status: Built** (approved by Scott 2026-11-13, after an outage cost the day's 8:00 run; open questions resolved below). Live once Scott stores the tokens (`scripts/set-routine-tokens.sh`; docs/SETUP.md). Plan: [tasks/routine-retry-plan.md](tasks/routine-retry-plan.md). Builds on the missed-run alert (#121).

**Why.** On 2026-11-13 Anthropic's incident "Elevated errors on claude.ai, the Claude API, and Claude Code" (from 13:09 UTC; connectors degraded until at least 14:36) cost the 8:00 run twice over: the scheduled fire at 13:05 never started a session, and two manual re-fires (14:35, 14:47) started but couldn't reach the Trader connector (a 502 from the connector gateway; Trader's MCP server logged no requests). Earlier in November the weekly usage limit stopped two runs. Each time `check-routine` emailed, and recovering needed a person to notice and press **Run now**. Missed runs will keep happening, for reasons outside Trader. Recovery shouldn't depend on someone watching.

**What.** When a run submits nothing, `check-routine` re-fires that routine through the routines API, waits, and tries once more; it emails only when the retries fail too, or can't be made.

**Assumptions (correct any of these):**
1. **The routines API's fire endpoint** (`POST https://api.anthropic.com/v1/claude_code/routines/{trigger_id}/fire`, `Authorization: Bearer <per-routine token>`, `anthropic-version`) is the mechanism. It's documented, in research preview ("might change"), and a routine keeps its schedule while it also accepts fires. Each fire creates a new session; there's no idempotency key. Limits: 30 fires an hour per routine, 100 per account.
2. **Tokens are made by Scott, by hand.** Each routine's token is generated in its settings on claude.ai (Trigger → + → API → Generate token), is shown once, and can only fire that routine (no read access). There's no API to create one. They go in SSM as one SecureString, `/trader/production/ROUTINE_FIRE_TOKENS`: JSON `{ "<trigger id>": "<token>" }`. Setting it is Scott's (CLAUDE.md: production secrets).
3. **Without tokens nothing changes:** the parameter is optional, and with it absent (or a slot's trigger missing from it) `check-routine` alerts at +45 minutes as today.
4. **A failed run costs little and a retried success costs one normal run** of that routine's model. Two retries a slot at most.
5. **The engine learns nothing from claude.ai.** It sees only whether a strategy was submitted (as #121 does): it can't tell "never started" from "failed to connect" from "still running". The retry delays allow for a slow run.

### When to retry
- Each fire time gets its trigger id and name beside it in core: `ROUTINES = [{ fireUtc: "13:00", triggerId: "trig_…", name }, …]` (`ROUTINE_RUNS_UTC` is derived from it). The existing test that keeps `agent/routines.json`'s crons in step also checks the trigger ids.
- **Retry 1** at fire time **+30 minutes**, **retry 2** at **+90 minutes**, each only if nothing has been submitted for the slot (the existing rule: a submission belongs to the latest fire time before it) and it's still a trading day (the calendar is asked only when something is missing, as now).
- **No retry fired after 14:45 ET**, so a retried run (~5 minutes) can submit before the rebalance window closes at 15:30. **No retry within 30 minutes of the next slot's fire time:** that run covers it.
- A run that's merely slow (still running at +30) can lead to two submissions for the slot; that's harmless (the second is a newer version) and accepted.

### Recording it (audit; ADR-008)
- **`routine.retry`**, before the API call, subject `<slot ISO>#<attempt>`: its existence is the claim, so a redelivered tick (ADR-007 already dedupes by `(job, scheduled_for)`) or a second tick can't fire twice. Payload: slot, attempt, trigger id, and the outcome once known (`fired` with the session URL, or `failed` with the HTTP status and error type, never the token).
  - Because rows can't be updated, the outcome is a second event: **`routine.retry_result`**, same subject.
- **`routine.missed`** (urgent, as now) moves later when tokens are set: at **+45 minutes after the last retry** (+135) if still nothing, or straight away when a retry can't be made (API error, 401/403 meaning a bad or revoked token, 429, no token for that trigger). Its email says what was tried: "Retried at 8:30 and 9:30 ET; neither submitted", or "Retry refused: the token for this routine was rejected (401). Regenerate it on claude.ai and update ROUTINE_FIRE_TOKENS."
- **Routing:** `routine.retry` and `routine.retry_result` go to the **digest** ("Research run retried at 8:30 ET; it submitted v19"). A retry that worked isn't an emergency; the owner reads it after the close.

### Shape (hexagonal, ADR-002)
- Core: a **`RoutineFirer` port** (`fire(triggerId, text) → { status: "fired", sessionUrl } | { status: "failed", httpStatus, errorType }`), and `checkRoutineRuns` extended with the retry schedule; a fake in tests.
- **`AnthropicRoutineFirer`** in core beside the port, on an injected `fetch` like `AlpacaBroker`, with a 15-second timeout; the token never reaches a log line, an event or an error message. `apps/lambda` builds it from the parsed config; `routine:fire` builds it from SSM.
- The fire's `text` names the retry ("Automatic retry 1 of the 8:00 ET run: the scheduled run submitted nothing by 8:30 ET"). The routine's stub doesn't need to read it; the session shows why it ran.
- **Config:** `ROUTINE_FIRE_TOKENS` added to `ENGINE_PARAMETERS` (so the engine role's `ssm:GetParameters` grant gains one ARN; `infra/test` pins it), optional and Zod-validated (a JSON object of `trig_…` ids to `sk-ant-oat01-…` tokens). Invalid JSON is a config error naming the variable, never its value; config fails closed as today.

### Not in scope
- Reading run logs or session status from claude.ai (no credential for that in the engine).
- Fixing a stuck schedule (the 8:00 routine's next-run time stayed at the outage's slot); that's on the claude.ai side and is watched by hand.
- Retrying a run that submitted something the owner dislikes, or one rejected by `submit_strategy` (`strategy.rejected` already counts as a run, as in #121).

### Testing
- Core (PGlite + a fake firer): no retry before +30; retry 1 at +30 and 2 at +90 when nothing was submitted; none once a submission lands; none on a holiday; none after 14:45 ET or within 30 minutes of the next slot; a redelivered tick doesn't fire twice; the missed alert at +135 after two failed retries, and at once when a fire is refused (401, 429, no token); without tokens, today's behaviour exactly.
- The adapter (core, fetch faked): its request (URL, headers, body), its timeout, and that error results carry no token. `apps/lambda`: it's built only when the tokens are configured.
- `infra/test`: the engine role's parameter list.
- Compose and routing tests for the new kinds.

### Boundaries
- **Always:** claim before firing; at most two retries a slot; keep the token out of logs, events and emails.
- **Ask first:** more retries, earlier retries, or retrying outside the trading window.
- **Never:** fire a routine other than the one whose slot was missed; store the token anywhere but SSM.

### Success criteria
1. With tokens set, a slot with no submission is re-fired at +30 and +90 minutes, each recorded before the call, and never twice for one attempt.
2. A retried run that submits closes the slot: no `routine.missed`, and the digest says it was retried.
3. If the retries don't produce a submission, or a fire is refused, Scott gets one urgent email saying what was tried and why it failed.
4. With `ROUTINE_FIRE_TOKENS` absent, behaviour is today's, and every existing `check-routine` test passes unchanged.
5. **Live check** (after Scott sets the tokens). A missed slot can't be staged on purpose, so the adapter is checked directly: `npm run routine:fire -w @trader/core -- --env production --routine 8:00 --dry-run` prints the request it would send (without the token); without `--dry-run` it fires once, and the session appears in RemoteTrigger's `list_runs`.

### Resolved questions (Scott, 2026-11-13)
1. **Retry times:** +30 and +90 minutes.
2. **Model:** a retry fires the slot's own routine, so it runs on the model that slot would have used (Opus at 8:00, Sonnet at 12:00).
3. **A successful retry** goes in the digest, not an urgent email.
4. **`routine:fire`**, a laptop command to fire a routine by hand (with `--dry-run`), is in scope: the live check, and manual recovery.

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
  - **Its database role is `trader_mcp`** (`scripts/mcp-role.ts`): `SELECT`, plus `INSERT` on `strategies` and `audit_events` (submit_strategy's writes), and on `watchlist_notes` (update_watchlist's, #32; granted by migration 0023 too) and `thesis_lessons` (record_lesson's, #28; migration 0028). ADR-011's rule (no order tools) now holds at the credential layer as well as the tool layer.
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
agent/routine-prompt.md       → the routine's prompt (each run reads it from main)
agent/routine-stub.md         → the routine's stored message: load the prompt from main
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
2. **The routine's identity:** resolved. Created with the schedule tooling in your account (Scott, 2026-11-01). Opus 5.5, staging first, then switched to the production connector. Split in two on 2026-11-12: Opus at 8:00, Sonnet at 12:00 (`agent/routines.json`).
