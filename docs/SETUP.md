# Setup

One-time account setup, plus the procedures that touch credentials or data. Everything else is `git push` (ADR-006).

## Accounts

| What | Where | Notes |
|---|---|---|
| GitHub repo | `whitebirchio/trader` (private) | Actions secrets and variables, below |
| AWS | Scott's account, `us-east-1` | the engine, defined in CDK under `infra/` (ADR-014) |
| Neon | project `trader`, AWS us-east-1 | branches `production` (default) and `staging` (child of `production`) |
| Cloudflare | Scott's account | **DNS and inbound mail for whitebirch.io only.** No Trader compute. |

### AWS (done 2026-11-01)

1. **CLI access through IAM Identity Center** (no root access keys). Turn on MFA for root. Enable IAM Identity Center (with Organizations), add user `scott`, create an `AdministratorAccess` permission set and assign it to the account. Then `aws configure sso --profile whitebirch` in a real terminal (session `whitebirch`, region `us-east-1`). Refresh with `aws sso login --profile whitebirch`.
2. **Bootstrap CDK** (once per account and region):
   ```sh
   cd infra && npx cdk bootstrap aws://$(aws sts get-caller-identity --profile whitebirch --query Account --output text)/us-east-1 --profile whitebirch
   ```
3. **Deploy the CI role** (`TraderCi`): GitHub's OIDC provider, plus `trader-github-deploy`, which trusts only this repo's immutable OIDC subject (`repo:whitebirchio@104479267/trader@1440835277:*`) and can only assume CDK's bootstrap roles. Re-run after changing `infra/lib/ci-stack.ts`. CI never deploys this stack.
   ```sh
   npm run deploy:ci -w trader-infra -- --profile whitebirch --require-approval never
   ```
   (`--require-approval never` because the `!` shell can't answer CDK's IAM prompt. Review `cdk diff TraderCi` first.)
4. **Confirm the emails AWS sends after the first deploy of each stack:** SES's verification for your Gmail (once), and the SNS subscription for `trader-alarms-staging` / `trader-alarms-production`.

### Neon

1. Create project `trader` (US East). Rename the default branch to `production`, then create a `staging` branch from it.
2. For each branch, go to **Connect**, copy the **pooled** URL for the owner role (`neondb_owner`), and add it to `.env` (copy `.env.example`). Quote the values: they contain `&`.

### GitHub Actions

| Name | Kind | Value |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | variable | `arn:aws:iam::<account>:role/trader-github-deploy` |
| `STAGING_MIGRATE_URL` | secret | owner URL of the `staging` branch |
| `PRODUCTION_MIGRATE_URL` | secret | owner URL of the `production` branch |

```sh
sed -n 's/^STAGING_MIGRATE_URL=//p' .env | tr -d "'\"" | gh secret set STAGING_MIGRATE_URL -R whitebirchio/trader
sed -n 's/^PRODUCTION_MIGRATE_URL=//p' .env | tr -d "'\"" | gh secret set PRODUCTION_MIGRATE_URL -R whitebirchio/trader
```

## What runs where

| Env | Stack | Lambda | Health URL | Alarm topic |
|---|---|---|---|---|
| staging | `TraderStaging` | `trader-engine-staging` | `https://lzelfa5mahlxfqnajfti2ettpi0ztqnb.lambda-url.us-east-1.on.aws/healthz` | `trader-alarms-staging` |
| production | `TraderProduction` | `trader-engine-production` | `https://fietbbxxxeyhge5eqpsa3455ym0tzodw.lambda-url.us-east-1.on.aws/healthz` | `trader-alarms-production` |

- **Schedule:** EventBridge Scheduler `trader-tick-<env>`, `cron(0/15 * * * ? *)`, runs `TICK_JOBS`.
- **Logs:** CloudWatch `/aws/lambda/trader-engine-<env>` (30 days).
- **Alarms:** emails on any Lambda error, and when there's been no invocation for an hour.
- **Run on demand** (it doesn't wait for the tick): `npm run invoke -- --env staging --jobs heartbeat,sync-broker`.

## Secrets (SSM Parameter Store)

Each environment's Lambda reads only `/trader/<env>/` (SecureStrings, default `aws/ssm` key), and re-reads at most every 15 minutes, so rotations apply without a deploy. Values go in through stdin and never appear in argv or output (`scripts/put-ssm-secret.sh`).

| Parameter | Written by |
|---|---|
| `/trader/<env>/DATABASE_URL` | `scripts/set-db-secret.sh <env>` |
| `/trader/<env>/ALPACA_KEY_ID`, `/trader/<env>/ALPACA_SECRET_KEY` | `scripts/set-alpaca-secret.sh <env>` |

## Database roles

Each branch has two roles (the same pattern as Fred):

| Role | Used by | Can |
|---|---|---|
| `neondb_owner` | CI migrations, this laptop | everything |
| `trader_app` | the engine's `DATABASE_URL` | DML, except only `SELECT, INSERT` on append-only tables; no DDL |

Roles are per-branch. Create a branch's role, or rotate its password, and store the URL in SSM in one step:

```sh
scripts/set-db-secret.sh staging      # or: production
```

The script fails if `trader_app` has any admin power, can `UPDATE`/`DELETE` an append-only table, or can create tables. It checks by connecting **as** `trader_app`.

Don't create `trader_app` from the Neon console. Console-created roles join `neon_superuser`.

## Alpaca (broker)

Each environment has its own key pair: **paper** for staging and **live** for production (ADR-005). The engine derives the Alpaca host from `TRADING_ENV`. A paper key sent to the live host gets `401` (checked 2026-10-31), so a key in the wrong environment can't reach the other account.

1. Put the keys in `.env` as `STAGING_ALPACA_KEY_ID` / `STAGING_ALPACA_SECRET_KEY` (paper) and `PRODUCTION_ALPACA_KEY_ID` / `PRODUCTION_ALPACA_SECRET_KEY` (live).
2. Store them: `scripts/set-alpaca-secret.sh staging` (or `production`).
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
npm run risk:check  -w @trader/core -- --env staging --sync --buy VTI=50 --buy AAPL=300:conviction   # dry run, records nothing
```

| Stop | Trips when | Blocks | Clears |
|---|---|---|---|
| Kill switch | you run `risk:kill` | every order | `risk:resume` |
| Drawdown halt | flow-adjusted equity ≤ −20% from peak (checked every sync) | every order | `risk:resume` only; recovery doesn't clear it |
| Daily loss pause | ≤ −5% vs prior close | buys only | by itself, next trading day (or on recovery above −5%) |
| Broker verdict | `broker_account.trading_allowed` is false | every order | fix the account (see Alpaca above) |

These scripts use the owner database URL and the environment's Alpaca keys from `.env`.

## Strategy & rebalancing

The active strategy is the highest version in `strategies`, or version 0 (100% VTI) before any is accepted. Claude submits through `agent` (not yet built); until then you can submit by hand. Every submission is validated, and a rejection is emailed while the old version stays active.

```sh
npm run strategy:show   -w @trader/core -- --env staging                         # active strategy, thesis states, holdings
npm run strategy:submit -w @trader/core -- --env staging --file strategy.json    # submit the next version (owner)
npm run rebalance:plan  -w @trader/core -- --env production --sync               # dry run through risk; records and orders nothing
npm run rebalance:run   -w @trader/core -- --env staging --sync                  # one real step on PAPER now (refuses production)
```

The `rebalance` job runs on `trader-rebalance-<env>`, every 15 min at :05/:20/:35/:50, 10:30–15:30 ET on trading days. Each step does sells only, or buys only, or nothing. It skips while orders are open, and records itself in `rebalance_plans`.

## Email

**Outbound (Trader → you): SES.** Trader sends from `trader@whitebirch.io` through SES, which stays in the **sandbox** on purpose: it can only email verified addresses. IAM also pins the from-address. The `whitebirch.io` domain identity (Easy DKIM) and your Gmail identity are created by `TraderStaging`. The 3 DKIM CNAMEs (`…._domainkey` → `….dkim.amazonses.com`, DNS-only) are in Cloudflare DNS. They were verified 2026-11-01.

| Command | Does |
|---|---|
| `npm run notify:test -w @trader/core -- --env staging\|production` | queue a test email (send it now with `npm run invoke -- --env <env> --jobs notify-urgent`) |
| `npm run notify:run -w @trader/core -- --env staging` | queue un-emailed urgent events now |
| `npm run notify:preview -w @trader/core -- --env … [--digest]` | print the pending urgent email or today's digest; sends nothing |

Staging queues everything but sends only test emails; its rows show `suppressed`. The outbox is the `notifications` table (`status`, `attempts`, `last_error`, `message_id`).

**Inbound (anyone → @whitebirch.io): Cloudflare Email Routing.** A catch-all forwards to your Gmail, using the `route1/2/3.mx.cloudflare.net` MX, the SPF (`include:_spf.mx.cloudflare.net`) and Cloudflare's `cf2024-1` DKIM.

**whitebirch.io DNS (moved from Squarespace 2026-10-31).** The nameservers are `edward`/`janet.ns.cloudflare.com`.
- **DNSSEC: active.** KSK tag `2371`, algorithm 13. The DS is at the registrar. For future changes, Cloudflare signing comes first, then the registrar's DS.
- **Site: GitHub Pages,** with `A`/`AAAA` records and `www` → `whitebirchio.github.io`, all **DNS-only** (grey cloud), so GitHub manages its own certificate. The `_github-pages-challenge-whitebirchio` TXT is kept. The Mailgun leftovers are deleted.

## Recovery procedures

### Staging schema ahead of production (ask first)

A migration from an abandoned branch stays applied to staging. Reset staging from its parent in the Neon console (**Branches → staging → Reset from parent**), then re-run `scripts/set-db-secret.sh staging`. The reset brings back production's copy of `trader_app` with a different password.

### Bad migration or bad data on production

Neon keeps point-in-time history (free plan: about 6 hours, so check the current limit). In the console, restore `production` to a timestamp before the bad deploy, then redeploy the last good commit by reverting on `main`. Write down what happened in an audit-worthy place (an issue).

### The engine stops (alarm: "not running")

Check `aws scheduler get-schedule --name trader-tick-<env> --profile whitebirch` and the Lambda's logs. `npm run invoke -- --env <env> --jobs heartbeat` shows whether the function itself works. A redeploy (re-run the CI workflow on the branch) restores both from CDK.
