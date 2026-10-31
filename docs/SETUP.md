# Setup

One-time account setup, plus the procedures that touch credentials or data. Everything else is `git push` (ADR-006).

## Accounts (done 2026-10-31)

| What | Where | Notes |
|---|---|---|
| GitHub repo | `whitebirchio/trader` (private) | Repo-level Actions secrets, below |
| Cloudflare | Scott's account, `*.whitebirch.workers.dev` | Workers free plan |
| Neon | project `trader`, AWS us-east-1 | branches `production` (default) and `staging` (child of `production`) |

### Neon

1. Create project `trader` (US East). Rename the default branch to `production`, then create a `staging` branch from it.
2. For each branch, go to **Connect**, copy the **pooled** URL for the owner role (`neondb_owner`), and add it to `.env` (copy `.env.example`). Quote the values: they contain `&`.

### Cloudflare

1. `cd apps/engine && npx wrangler login`
2. My Profile → API Tokens → **"Edit Cloudflare Workers"** template → `gh secret set CLOUDFLARE_API_TOKEN -R whitebirchio/trader` (it prompts, so the value never lands in shell history).

### GitHub Actions secrets

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token above |
| `STAGING_MIGRATE_URL` | owner URL of the `staging` branch |
| `PRODUCTION_MIGRATE_URL` | owner URL of the `production` branch |

```sh
sed -n 's/^STAGING_MIGRATE_URL=//p' .env | tr -d "'\"" | gh secret set STAGING_MIGRATE_URL -R whitebirchio/trader
sed -n 's/^PRODUCTION_MIGRATE_URL=//p' .env | tr -d "'\"" | gh secret set PRODUCTION_MIGRATE_URL -R whitebirchio/trader
```

## Database roles

Each branch has two roles (the same pattern as Fred):

| Role | Used by | Can |
|---|---|---|
| `neondb_owner` | CI migrations, this laptop | everything |
| `trader_app` | the Worker's `DATABASE_URL` | DML on `job_runs`; only `SELECT, INSERT` on `audit_events`; no DDL |

Roles are per-branch. Create a branch's role, or rotate its password, and set the matching Worker secret in one step:

```sh
scripts/set-db-secret.sh staging      # or: production
```

The Worker must exist first, so for a new environment, deploy once and then run this. The script fails if `trader_app` has any admin power or can `UPDATE`/`DELETE` audit events or create tables. It checks by connecting **as** `trader_app`.

Don't create `trader_app` from the Neon console. Console-created roles join `neon_superuser`.

## Alpaca (broker)

Each environment has its own key pair: **paper** for staging and **live** for production (ADR-005). The Worker derives the Alpaca host from `TRADING_ENV`. A paper key sent to the live host gets `401` (checked 2026-10-31), so a key in the wrong environment can't reach the other account.

1. Put the keys in `.env` as `STAGING_ALPACA_KEY_ID` / `STAGING_ALPACA_SECRET_KEY` (paper) and `PRODUCTION_ALPACA_KEY_ID` / `PRODUCTION_ALPACA_SECRET_KEY` (live).
2. Set the Worker secrets: `scripts/set-alpaca-secret.sh staging` (or `production`). The Worker must already exist.
3. Apply the required account configuration: margin multiplier 1, so buying power = cash; shorting off; fractional trading on. Until it's applied, `sync-broker` reports `tradingAllowed = false`:
   ```sh
   npm run broker:configure -w @trader/core -- --env staging --check   # show only
   npm run broker:configure -w @trader/core -- --env staging           # apply
   ```

Operator scripts (staging/paper only):

| Command | Does |
|---|---|
| `npm run broker:sync -w @trader/core -- --env staging [--force]` | one sync now; `--force` ignores the market-hours gate |
| `npm run broker:smoke -w @trader/core -- --env staging` | $5 VTI buy → fill → lot/position/audit checks (market hours only) |
| `npm run broker:capture -w @trader/core` | re-record scrubbed test fixtures from the paper account |

Configuration and the `tradingAllowed` verdict are visible in `broker_account` (`trading_allowed`, `blocked_reasons`). Each change in the verdict is one `broker.*` audit event.

## Risk controls

The limits are code in `packages/core/src/risk/limits.ts`. Changing one is a PR, which runs on paper (staging) before it reaches live. The kill switch and the drawdown halt are database state that only you can clear (ADR-012). Each command takes `--env staging|production` and records your `--reason` in the audit log as `actor: owner`:

```sh
npm run risk:status -w @trader/core -- --env production                     # kill switch, halt, drawdown, today, verdict
npm run risk:kill   -w @trader/core -- --env production --reason "…"        # stop all trading now (sells too)
npm run risk:resume -w @trader/core -- --env production --reason "…"        # clear the kill switch and/or halt
npm run risk:check  -w @trader/core -- --env staging --sync --buy VTI=50 --buy AAPL=300:satellite   # dry run, records nothing
```

| Stop | Trips when | Blocks | Clears |
|---|---|---|---|
| Kill switch | you run `risk:kill` | every order | `risk:resume` |
| Drawdown halt | flow-adjusted equity ≤ −20% from peak (checked every sync) | every order | `risk:resume` only; recovery doesn't clear it |
| Daily loss pause | ≤ −5% vs prior close | buys only | by itself, next trading day (or on recovery above −5%) |
| Broker verdict | `broker_account.trading_allowed` is false | every order | fix the account (see Alpaca above) |

These scripts use the owner database URL and the environment's Alpaca keys from `.env`.

## Email (notifications)

Trader emails only you, from `trader@whitebirch.io`, using Cloudflare Email Routing's free send-to-verified-address path (SPEC-notifications).

**Domain setup (done 2026-10-31).** whitebirch.io's DNS moved from Squarespace to Cloudflare. The nameservers are `edward`/`janet.ns.cloudflare.com`.
- **Kept as they were:** the GitHub Pages `A`/`AAAA` records (DNS-only), `www` → `whitebirchio.github.io`, and the `_github-pages-challenge-whitebirchio` TXT.
- **Replaced:** Squarespace's Mailgun-based forwarding became Email Routing, with a **catch-all → your Gmail** (verified). Email Routing publishes the `route1/2/3.mx.cloudflare.net` MX, the SPF and the `cf2024-1` DKIM records.
- **Still to do:** re-enable DNSSEC (Cloudflare → DNS → Settings → DNSSEC, then add the DS at the registrar), and delete the leftover Mailgun `k1._domainkey` record.

**The Worker's side.** `apps/engine/wrangler.jsonc` has a `send_email` binding (`EMAIL`) with `destination_address` set to your Gmail, so the Worker can't email anyone else, plus the `NOTIFY_FROM` and `NOTIFY_TO` vars.

| Command | Does |
|---|---|
| `npm run notify:test -w @trader/core -- --env staging\|production` | queue a test email; the next tick sends it |
| `npm run notify:preview -w @trader/core -- --env … [--digest]` | print the pending urgent email or today's digest; sends nothing |

Staging queues everything but sends only test emails; its rows show `suppressed`. The outbox is the `notifications` table (`status`, `attempts`, `last_error`, `message_id`).

## Local development

```sh
{ sed -n 's/^STAGING_MIGRATE_URL=//p' .env | tr -d "'\"" | sed 's/^/DATABASE_URL=/'
  sed -n 's/^STAGING_ALPACA_KEY_ID=//p' .env | tr -d "'\"" | sed 's/^/ALPACA_KEY_ID=/'
  sed -n 's/^STAGING_ALPACA_SECRET_KEY=//p' .env | tr -d "'\"" | sed 's/^/ALPACA_SECRET_KEY=/'; } > apps/engine/.dev.vars
npm run dev                                          # :8787, TRADING_ENV=staging
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
curl http://localhost:8787/healthz
```

Local dev writes to the **staging** branch, using the owner role for convenience. Never point `.dev.vars` at production.

## Recovery procedures

### Staging schema ahead of production (ask first)

A migration from an abandoned branch stays applied to staging. Reset staging from its parent in the Neon console (**Branches → staging → Reset from parent**), then re-run `scripts/set-db-secret.sh staging`. The reset brings back production's copy of `trader_app` with a different password.

### Bad migration or bad data on production

Neon keeps point-in-time history (free plan: about 6 hours, so check the current limit). In the console, restore `production` to a timestamp before the bad deploy, then redeploy the last good commit by reverting on `main`. Write down what happened in an audit-worthy place (an issue).
