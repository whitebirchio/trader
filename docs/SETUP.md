# Setup

One-time account setup, plus the procedures that touch credentials or data. Everything else is `git push`. Production is the only deployed environment (ADR-018): a merge to `main` deploys it, and other branches only build, test and check their migrations.

## Accounts

| What | Where | Notes |
|---|---|---|
| GitHub repo | `whitebirchio/trader` (private) | Actions secrets and variables, below |
| AWS | Scott's account, `us-east-1` | the engine, defined in CDK under `infra/` (ADR-014) |
| Neon | project `trader`, AWS us-east-1 | branch `production` (default); CI makes and deletes a temporary child branch per push to check migrations |
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
4. **Confirm the emails AWS sends after the first deploy:** SES's verification for your Gmail (once), and the SNS subscription for `trader-alarms-production`.

### Neon

1. Create project `trader` (US East). Rename the default branch to `production`.
2. Go to **Connect**, copy the **pooled** URL for the owner role (`neondb_owner`), and add it to `.env` as `PRODUCTION_MIGRATE_URL` (copy `.env.example`). Quote the values: they contain `&`.
3. For CI's migration check: create an API key (**Account settings → API keys**) and note the project ID (**Settings → General**). They go in GitHub below.

### GitHub Actions

| Name | Kind | Value |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | variable | `arn:aws:iam::<account>:role/trader-github-deploy` |
| `PRODUCTION_MIGRATE_URL` | secret | owner URL of the `production` branch (main's deploy migrates with it) |
| `NEON_API_KEY` | secret | a Neon API key, for the migration check's temporary branches |
| `NEON_PROJECT_ID` | variable | the Neon project's ID |

```sh
sed -n 's/^PRODUCTION_MIGRATE_URL=//p' .env | tr -d "'\"" | gh secret set PRODUCTION_MIGRATE_URL -R whitebirchio/trader
gh secret set NEON_API_KEY -R whitebirchio/trader          # paste the key at the prompt; it never touches argv or a file
gh variable set NEON_PROJECT_ID -R whitebirchio/trader --body <project-id>
```

## What runs where

| Env | Stack | Lambda | Health URL | Alarm topic |
|---|---|---|---|---|
| production | `TraderProduction` | `trader-engine-production` | `https://fietbbxxxeyhge5eqpsa3455ym0tzodw.lambda-url.us-east-1.on.aws/healthz` | `trader-alarms-production` |

- **Schedule:** EventBridge Scheduler `trader-tick-<env>`, `cron(0/15 * * * ? *)`, runs `TICK_JOBS`.
- **Logs:** CloudWatch `/aws/lambda/trader-engine-<env>` (30 days).
- **Alarms:** emails on any Lambda error, and when there's been no invocation for an hour.
- **Run on demand** (it doesn't wait for the tick): `npm run invoke -- --env production --jobs heartbeat,sync-broker`. A slot already claimed returns `duplicate`.
- **Before merge:** CI's `migrate-check` applies the branch's migrations to a temporary copy of production and deletes it (`scripts/ci-migrate-check.sh`). It prints only pass or fail, because the copy holds live data and the logs are public; rerun it locally with `NEON_API_KEY` and `NEON_PROJECT_ID` set to see an error.

## Secrets (SSM Parameter Store)

The Lambdas read only `/trader/production/` (SecureStrings, default `aws/ssm` key), and each reads only its own names: the engine `ENGINE_PARAMETERS`, the MCP server `MCP_PARAMETERS`, the dashboard its three. Each re-reads at most hourly, so rotations apply without a deploy, within the hour. Every decrypted SecureString is a KMS request (20,000 a month are free). Values go in through stdin and never appear in argv or output (`scripts/put-ssm-secret.sh`).

| Parameter | Written by |
|---|---|
| `/trader/<env>/DATABASE_URL` | `scripts/set-db-secret.sh <env>` |
| `/trader/<env>/ALPACA_KEY_ID`, `/trader/<env>/ALPACA_SECRET_KEY` | `scripts/set-alpaca-secret.sh <env>` |
| `/trader/<env>/MCP_SIGNING_KEY`, `MCP_PASSPHRASE`, `MCP_TOKEN`, `MCP_DATABASE_URL`, `MCP_ALPACA_KEY_ID`, `MCP_ALPACA_SECRET_KEY` | `scripts/set-mcp-secrets.sh <env>` (values in `.env` as `<ENV>_MCP_*`; it creates or rotates `trader_mcp` with `<ENV>_MIGRATE_URL` and copies the paper key `STAGING_ALPACA_*`) |
| `/trader/<env>/DATABASE_READ_URL`, `DASHBOARD_SESSION_KEY`, `GOOGLE_CLIENT_SECRET` | `scripts/set-dashboard-secrets.sh <env>` |
| `/trader/production/READONLY_DATABASE_URL` | `scripts/set-readonly-secret.sh` (creates or rotates `trader_readonly`; read from the laptop only, by the read-only status scripts, never by a Lambda) |
| `/trader/<env>/ALPHAVANTAGE_API_KEY` *(optional, #30)* | `scripts/set-alphavantage-secret.sh <env>` (value in `.env` as `ALPHAVANTAGE_API_KEY`; one free key from alphavantage.co, 25 requests a day). Without it, the `earnings-calendar` job skips, and the tools say the calendar is missing. `npm run earnings:refresh -w @trader/core -- --env <env> --show AAPL` fetches it now. |

| `/trader/production/ROUTINE_FIRE_TOKENS` *(optional, SPEC-agent § Missed-run recovery)* | `scripts/set-routine-tokens.sh` (one hidden prompt per routine in `agent/routines.json`). Generate each routine's token in its settings on claude.ai: **Trigger → + → API → Generate token**; it's shown once, and can only start that routine. Without the parameter, `check-routine` emails a missed run and doesn't retry. To rotate, **Regenerate** on claude.ai (the old token stops working) and run the script again. |

The dashboard's role reads only its three parameters, by exact name (`ssm:GetParameters`), never the path, so it can't see the Alpaca keys.

## Database roles

The `production` branch has these roles (the same pattern as Fred):

| Role | Used by | Can |
|---|---|---|
| `neondb_owner` | CI migrations, this laptop | everything |
| `trader_app` | the engine's `DATABASE_URL` | DML, except only `SELECT, INSERT` on append-only tables; no DDL |
| `trader_dashboard` | the dashboard's `DATABASE_READ_URL` | `SELECT`, plus `INSERT` on `capital_commands` (the dashboard's withdrawal command), in read-only transactions by default; created/rotated by `scripts/set-dashboard-secrets.sh <env>`, which proves every other write is denied |
| `trader_readonly` | `READONLY_DATABASE_URL`: the read-only status scripts Claude may run (ADR-018) | `SELECT` only, read-only transactions; created/rotated by `scripts/set-readonly-secret.sh`, which proves every write is denied, read-write transactions included |

Roles are per-branch. Create a branch's role, or rotate its password, and store the URL in SSM in one step:

```sh
scripts/set-db-secret.sh production
```

The script fails if `trader_app` has any admin power, can `UPDATE`/`DELETE` an append-only table, or can create tables. It checks by connecting **as** `trader_app`.

Don't create `trader_app` from the Neon console. Console-created roles join `neon_superuser`.

## Alpaca (broker)

Two key pairs: **live** for production, and **paper**, which serves market data to the MCP server, the research scripts and the replay, and the paper rehearsal (ADR-018). The engine derives the Alpaca host from `TRADING_ENV`. A paper key sent to the live host gets `401` (checked 2026-10-31), so a key in the wrong environment can't reach the other account.

1. Put the keys in `.env` as `STAGING_ALPACA_KEY_ID` / `STAGING_ALPACA_SECRET_KEY` (paper) and `PRODUCTION_ALPACA_KEY_ID` / `PRODUCTION_ALPACA_SECRET_KEY` (live).
2. Store the live pair: `scripts/set-alpaca-secret.sh production`. The paper pair stays in `.env` (and in the MCP server's `MCP_ALPACA_*`).
3. Apply the required account configuration: margin multiplier 1, so buying power = cash; shorting off; fractional trading on. Until it's applied, `sync-broker` reports `tradingAllowed = false`:
   ```sh
   npm run broker:configure -w @trader/core -- --env production --check   # show only (--env paper for the paper account)
   npm run broker:configure -w @trader/core -- --env production           # apply
   ```

**The paper rehearsal** (ADR-018): `--env paper` on the operator scripts uses the paper account and a local database in `packages/core/.cache/paper-db`, kept between commands and rebuilt when the migrations change (delete it to start over). It runs as `TRADING_ENV=staging`, the not-live value. Rehearse any change to `src/broker/`, `src/risk/`, `src/portfolio/rebalance.ts` or the order intents here before merging it.

| Command | Does |
|---|---|
| `npm run broker:sync -w @trader/core -- --env paper [--force]` | sync the paper account into the local database; `--force` ignores the market-hours gate. `--env production --force` is allowed for the gap before a session (mirror only, never orders) |
| `npm run broker:smoke -w @trader/core -- --env paper` | $5 VTI buy on paper → fill → lot/position/audit checks (market hours only) |
| `npm run rebalance:run -w @trader/core -- --env paper --sync` | one real rebalance step on paper (refuses production); submit a strategy first with `strategy:submit --env paper` |
| `npm run broker:capture -w @trader/core` | re-record scrubbed test fixtures from the paper account |

Configuration and the `tradingAllowed` verdict are visible in `broker_account` (`trading_allowed`, `blocked_reasons`). Each change in the verdict is one `broker.*` audit event.

## Risk controls

The limits are code in `packages/core/src/risk/limits.ts`. Changing one is a PR; rehearse it on paper before it reaches live. The kill switch and the drawdown halt are database state that only you can clear (ADR-012). Each command takes `--env production|paper` and records your `--reason` in the audit log as `actor: owner`:

```sh
npm run risk:status -w @trader/core -- --env production                     # kill switch, halt, drawdown, today, verdict
npm run risk:kill   -w @trader/core -- --env production --reason "…"        # stop all trading now (sells too)
npm run risk:resume -w @trader/core -- --env production --reason "…"        # clear the kill switch and/or halt
npm run risk:check  -w @trader/core -- --env paper --sync --buy VTI=50 --buy AAPL=300:conviction   # dry run, records nothing
```

| Stop | Trips when | Blocks | Clears |
|---|---|---|---|
| Kill switch | you run `risk:kill` | every order | `risk:resume` |
| Drawdown halt | flow-adjusted equity ≤ −20% from peak (checked every sync) | every order | `risk:resume` only; recovery doesn't clear it |
| Daily loss pause | ≤ −5% vs prior close | buys only | by itself, next trading day (or on recovery above −5%) |
| Broker verdict | `broker_account.trading_allowed` is false | every order | fix the account (see Alpaca above) |

These scripts use the owner database URL and the live keys from `.env`, except the read-only ones (`risk:status`, `strategy:show`, `capital:status`, `scorecard:show`). Those read `/trader/production/READONLY_DATABASE_URL` from SSM (`trader_readonly`, SELECT only), take market data from the paper key, and refuse a connection that can write, so Claude may run them.

## Strategy & rebalancing

The active strategy is the highest version in `strategies`, or version 0 (100% VTI) before any is accepted. Claude submits through `agent` (not yet built); until then you can submit by hand. Every submission is validated, and a rejection is emailed while the old version stays active.

```sh
npm run strategy:show   -w @trader/core -- --env production                      # active strategy, thesis states, holdings (read-only)
npm run strategy:submit -w @trader/core -- --env paper --file strategy.json      # submit the next version (owner; --env production for live)
npm run rebalance:plan  -w @trader/core -- --env production --sync               # dry run through risk; records and orders nothing
npm run rebalance:run   -w @trader/core -- --env paper --sync                    # one real step on PAPER now (refuses production)
```

The `rebalance` job runs on `trader-rebalance-production`, every 15 min, 9:45–15:30 ET on trading days. Each step does sells only, or buys only, or nothing. It skips while orders are open, and records itself in `rebalance_plans`.

## Email

**Outbound (Trader → you): SES.** Trader sends from `trader@whitebirch.io` through SES, which stays in the **sandbox** on purpose: it can only email verified addresses. IAM also pins the from-address. The `whitebirch.io` domain identity (Easy DKIM) and your Gmail identity belong to `TraderProduction`, retained so they outlive the stack. `TraderStaging` created them; production imported them on 2026-11-11 (ADR-018). The 3 DKIM CNAMEs (`…._domainkey` → `….dkim.amazonses.com`, DNS-only) are in Cloudflare DNS. They were verified 2026-11-01.

| Command | Does |
|---|---|
| `npm run notify:test -w @trader/core -- --env production` | queue a test email (send it now with `npm run invoke -- --env production --jobs notify-urgent`) |
| `npm run notify:run -w @trader/core -- --env production` | queue un-emailed urgent events now |
| `npm run notify:preview -w @trader/core -- --env … [--digest \| --weekly [--date YYYY-MM-DD]]` | print the pending urgent email, today's digest, or a week's letter; sends nothing |

A not-live env (`staging`: the replay, the paper rehearsal) queues everything but sends only test emails; its rows show `suppressed`. The outbox is the `notifications` table (`status`, `attempts`, `last_error`, `message_id`).

**Inbound (anyone → @whitebirch.io): Cloudflare Email Routing.** A catch-all forwards to your Gmail, using the `route1/2/3.mx.cloudflare.net` MX, the SPF (`include:_spf.mx.cloudflare.net`) and Cloudflare's `cf2024-1` DKIM.

**whitebirch.io DNS (moved from Squarespace 2026-10-31).** The nameservers are `edward`/`janet.ns.cloudflare.com`.
- **DNSSEC: active.** KSK tag `2371`, algorithm 13. The DS is at the registrar. For future changes, Cloudflare signing comes first, then the registrar's DS.
- **Site: GitHub Pages,** with `A`/`AAAA` records and `www` → `whitebirchio.github.io`, all **DNS-only** (grey cloud), so GitHub manages its own certificate. The `_github-pages-challenge-whitebirchio` TXT is kept. The Mailgun leftovers are deleted.

## Dashboard

Read-only dashboard at **https://trader.whitebirch.io** (SPEC-dashboard). It's a Lambda Web Function (`trader-dashboard-production`) behind CloudFront. The function's own endpoint URL refuses everything except that distribution (OAC + resource policy).

- **Sign-in:** Google OAuth client "Trader" (Google Cloud Console). It's a Web application client in Testing mode, with the owner as a test user. Its redirect URIs are `https://trader.whitebirch.io/auth/callback` and `http://localhost:3000/auth/callback`. The client id is in `infra/lib/config.ts` (it's public). The secret is in `.env` (`GOOGLE_CLIENT_SECRET`) and SSM. Only `OWNER_EMAIL`, verified by Google, gets in. Sessions last 30 days. Rotating `DASHBOARD_SESSION_KEY` signs everyone out.
- **Certificate:** `TraderCerts` holds one ACM certificate for `trader` and the retired `trader-staging` (dropped when it's next reissued, ADR-018), deployed once from the laptop (`npx cdk deploy TraderCerts --exclusively --profile whitebirch`). Its two DNS-validation CNAMEs (`_…​.trader` and `_…​.trader-staging` → `….acm-validations.aws`) are in Cloudflare and must stay there for renewal.
- **DNS:** `trader` is a CNAME to the stack's CloudFront domain (output `DashboardCname`), DNS-only.
- **Build:** `npm run build -w trader-dashboard` (webpack; Turbopack can't map core's `.js` imports to `.ts`) produces `apps/dashboard/dist/app`, the CDK asset. CI builds it before synth and deploys.
- **Local:** `DATABASE_READ_URL=… DASHBOARD_SESSION_KEY=… GOOGLE_CLIENT_SECRET=… TRADING_ENV=staging DASHBOARD_URL=http://localhost:3000 OWNER_EMAIL=… GOOGLE_CLIENT_ID=… DASHBOARD_DEV_EMAIL=<owner> npm run dev -w trader-dashboard`. The `DASHBOARD_DEV_EMAIL` bypass works only under `next dev`.
- **Logs:** `/aws/lambda/web/trader-dashboard-production` (and `.local`). Sign-ins log `signed in` / `sign-in refused` with the reason.

## Recovery procedures

### A migration fails CI's check

`migrate-check` hides the error, because the copy holds live data and the logs are public. Run `NEON_API_KEY=… NEON_PROJECT_ID=… scripts/ci-migrate-check.sh` with its `>/dev/null 2>&1` removed, locally, to see it. The script deletes its branch either way, and a branch left by a cancelled run expires after 2 hours.

### Bad migration or bad data on production

Neon keeps point-in-time history (free plan: about 6 hours, so check the current limit). In the console, restore `production` to a timestamp before the bad deploy, then redeploy the last good commit by reverting on `main`. Write down what happened in an audit-worthy place (an issue).

### A research run is missed (email: "Research run missed")

With `ROUTINE_FIRE_TOKENS` set, `check-routine` has already retried the run at +30 and +90 minutes; the email says what happened to each try. Check status.claude.com (an outage) and the routine's runs at claude.ai/code (the weekly usage limit, a connector that failed to connect). Once the cause has cleared, start it again: `npm run routine:fire -w @trader/core -- --env production --routine 8:00` (or **Run now** on claude.ai). A refused retry (401/403) means the token was revoked or regenerated: make a new one and rerun `scripts/set-routine-tokens.sh`. The last strategy keeps executing meanwhile, and a missed run unwinds nothing.

### The engine stops (alarm: "not running")

Check `aws scheduler get-schedule --name trader-tick-production --profile whitebirch` and the Lambda's logs. `npm run invoke -- --env production --jobs heartbeat` shows whether the function itself works. A redeploy (re-run the CI workflow on `main`) restores both from CDK.
