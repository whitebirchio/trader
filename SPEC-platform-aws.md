# Spec: move the platform to AWS (`foundation`, revision 2)

> **Status: Approved** (Scott, 2026-10-31). A change to the implemented `foundation` module ([SPEC-foundation.md](SPEC-foundation.md)), plus the hosting parts of `broker`, `risk` and `notifications`. It's done **before `portfolio`**, which then builds on the new platform. Supersedes ADR-001's hosting decision.

## Objective

Run Trader's engine entirely on **AWS, provisioned and managed with CDK**, in your existing account in `us-east-1` (Scott, 2026-10-31). The goals: one familiar platform, room to grow without plan-limit tiptoeing, and effectively no new bill.

**Nothing about what Trader does changes.** Every job, guardrail, email and test behaves the same. All logic stays in `@trader/core`, which has no Cloudflare dependency today. Only the thin app shell and the deploy pipeline are replaced (ADR-002 pays off here).

| Concern | Today (Cloudflare) | After (AWS) |
|---|---|---|
| Scheduled jobs | Workers cron `*/15` → `scheduled()` | **EventBridge Scheduler** (`rate`/`cron`) → **Lambda** (Node 22, arm64) |
| `/healthz` | Worker route | Lambda **Function URL** (public, health only; it reveals nothing about the account) |
| Secrets | Worker secrets | **SSM Parameter Store** SecureStrings under `/trader/<env>/…`, read once per cold start |
| Outbound email | `send_email` binding | **SES** (v2 API), domain identity `whitebirch.io` with Easy DKIM, kept in the **SES sandbox**, so it can only email your verified address |
| Logs | Workers observability | **CloudWatch Logs**, 30-day retention |
| Alarms | — | CloudWatch alarms → SNS → your email, for **Lambda errors** and for **no successful invocation in 1 hour** (a dead-man's switch for the scheduler itself) |
| Deploys | `wrangler-action` | GitHub Actions → **`cdk deploy`** using a **GitHub OIDC role** (no long-lived AWS keys in GitHub). Feature branches → `TraderStaging`, `main` → `TraderProduction`. |
| Database | Neon (free) | **unchanged:** Neon Postgres, same schema and roles |
| DNS + inbound mail | Cloudflare (free) | **unchanged:** Cloudflare DNS, plus Email Routing's catch-all to Gmail |

**Expected AWS cost: about $0 a month.** About 3,000 Lambda invocations a month (plus ops calls) is well inside the always-free tier (1M requests and 400k GB-seconds a month). The always-free tier also covers EventBridge Scheduler (14M a month), SSM standard parameters, CloudWatch (5 GB of logs, 10 alarms) and SNS email (1,000 a month). SES is $0.10 per 1,000 emails, so a few cents a year. Cloudflare stays on its free plan for DNS and inbound mail only.

## Design

### Repo layout

```
infra/                         → new workspace "trader-infra" (CDK v2, TypeScript)
  bin/trader.ts                → app: TraderCi (once), TraderStaging, TraderProduction
  lib/engine-stack.ts          → one environment: Lambda, schedules, Function URL, SSM grants, SES, alarms
  lib/ci-stack.ts              → GitHub OIDC provider + deploy role (deployed once, by you)
  cdk.json
apps/engine/
  src/lambda.ts                → handler: scheduler events → runJob; Function URL → /healthz
  src/ses-mailer.ts            → Mailer port over SESv2 SendEmail
  src/secrets.ts               → SSM GetParameters (ENGINE_PARAMETERS) → env-shaped config (cached per container for an hour)
  (src/index.ts, wrangler.jsonc, worker-configuration.d.ts removed at cutover)
```

`@trader/core` is unchanged except where noted below. `parseConfig` keeps validating the same names; they just arrive from SSM instead of Worker secrets.

### Lambda and schedules

- **One function per environment:** `trader-engine-staging` and `trader-engine-production`. Bundled by CDK's `NodejsFunction` (esbuild), Node 22, arm64, 512 MB, 5-minute timeout. Environment variables carry only non-secrets: `TRADING_ENV`, `NOTIFY_FROM`, `NOTIFY_TO`, and the SSM path.
- **Schedules:** an EventBridge Scheduler schedule `cron(0/15 * * * ? *)`, with input `{"jobs": [...], "scheduledTime": "<aws.scheduler.scheduled-time>"}`. The scheduled time feeds `slotFor()`, so idempotency per `(job, slot)` works exactly as before (ADR-007). Retries are allowed: a retried delivery is a recorded no-op. `portfolio` can later add its own schedule (e.g. for `rebalance`) without plan limits.
- **Fail closed, unchanged:** invalid config or missing SSM parameters mean no jobs run, an error log entry, the error alarm fires, and `/healthz` returns 503 naming what's missing.

### Secrets

| Parameter (SecureString) | Replaces |
|---|---|
| `/trader/<env>/DATABASE_URL` | Worker secret `DATABASE_URL` (the `trader_app` role URL) |
| `/trader/<env>/ALPACA_KEY_ID`, `/trader/<env>/ALPACA_SECRET_KEY` | Worker secrets of the same names |

`scripts/set-db-secret.sh` and `scripts/set-alpaca-secret.sh` write SSM instead of Worker secrets. The values never get printed, as now. The Lambda's IAM role can read only `/trader/<env>/*` for its own environment, so staging can't read production's keys. This strengthens ADR-005.

### Email (SES)

- **CDK creates the identities.** The domain identity `whitebirch.io` (Easy DKIM, 3 CNAME records) and the email identity `scott.schmalz@gmail.com`. You click one SES verification email. The stack outputs the 3 DKIM CNAMEs, and you add them in Cloudflare DNS **DNS-only**.
- **Stays in the SES sandbox on purpose.** In the sandbox SES can only send to verified addresses, which is exactly Trader's rule ("only email the owner"). The IAM policy also pins `ses:FromAddress` to `trader@whitebirch.io`.
- **`SesMailer` implements the existing `Mailer` port,** so the outbox, routing, composition and suppression are untouched. Sending from SES doesn't touch inbound mail: the Cloudflare Email Routing MX and catch-all stay as they are.

### CI (`.github/workflows/ci.yml`)

| Trigger | Jobs |
|---|---|
| Every push | `build`: `npm ci` → typecheck → test → **`cdk synth`** (catches infra errors on every branch) |
| Non-`main` push | `build` → migrate the Neon `staging` branch → `cdk deploy TraderStaging` |
| `main` push | `build` → migrate the Neon `production` branch → `cdk deploy TraderProduction` |

AWS access is through `aws-actions/configure-aws-credentials` assuming the OIDC role from `TraderCi`. The trust policy is restricted to `repo:whitebirchio/trader:*`. The Neon migrate URLs stay as GitHub secrets, and `CLOUDFLARE_API_TOKEN` is removed after cutover.

### Cutover (no gap, no double-trading)

Both platforms can safely run side by side, because every job claims `(job, slot)` in the shared database before running, and every email is claimed in the outbox before sending. Whichever platform fires first does the work; the other gets `duplicate`. So:

1. Deploy `TraderStaging` while the Cloudflare staging Worker still runs. Confirm AWS is claiming slots, and test with `notify:test` via SES.
2. Delete the Cloudflare staging Worker.
3. Merge to `main`: `TraderProduction` deploys alongside the Cloudflare production Worker. Confirm, then delete the Cloudflare production Worker.
4. Remove `wrangler.jsonc`, the Worker entry point, the `wrangler` dependency, and the `CLOUDFLARE_API_TOKEN` secret. Cloudflare keeps only DNS and Email Routing.

### ADRs

- **ADR-014 "Run on AWS with CDK; keep Neon and Cloudflare DNS/inbound mail".** Supersedes ADR-001. It records why (familiarity, flexibility, one bill), what stays and why (Neon is free Postgres; Cloudflare DNS and forwarding are free and just moved), and the cost picture.
- **ADR-006's branch-to-environment rule is unchanged;** only the deploy mechanism changes. It's noted in ADR-014.

## Assumptions (correct any of these)

1. **Deployment order:** you deploy `TraderCi` (the OIDC role) once from your laptop with your own credentials, along with `cdk bootstrap`. Everything after that deploys from CI.
2. **No VPC.** The Lambda reaches Neon, Alpaca and SES over the public internet with TLS, as the Worker does today. A VPC would add a NAT gateway (about $32/mo) for no benefit here.
3. **The health URL changes** from `*.workers.dev` to a `*.lambda-url.us-east-1.on.aws` URL, output by the stack and recorded in `docs/SETUP.md`.
4. **Later modules on AWS** (Scott, 2026-10-31). `agent`'s MCP server becomes a Lambda + Function URL with its own OAuth, and `dashboard` becomes S3 + CloudFront behind auth. Each is designed in its own spec. Nothing in this spec builds them.

## Commands

```sh
npm run typecheck && npm test                     # gate (now includes infra typecheck)
npm run synth -w trader-infra                     # cdk synth all stacks
npm run deploy:ci -w trader-infra                 # once, by you: OIDC role (needs your AWS credentials)
npm run deploy:staging -w trader-infra            # what CI runs on feature branches
npm run deploy:production -w trader-infra         # what CI runs on main (manual = break-glass)
scripts/set-db-secret.sh staging|production       # trader_app role → SSM (rewritten)
scripts/set-alpaca-secret.sh staging|production   # Alpaca keys → SSM (rewritten)
npm run invoke -w trader-engine -- --env staging --jobs heartbeat,sync-broker   # run the deployed Lambda now (fast verification)
```

## Testing Strategy

- **Core:** unchanged, all 219 tests.
- **App:** unit tests for the Lambda handler. A scheduler event maps jobs and passes the slot; a Function URL GET `/healthz` gives 200 or 503; bad config means 503 naming the parameters and no jobs. Also the `SesMailer` request shape (mocked client) and the `secrets.ts` mapping.
- **Infra:** CDK assertions (`aws-cdk-lib/assertions`):
  - Each stack has exactly one function, one schedule, and one Function URL with `AuthType NONE`.
  - The IAM role can read only its own environment's SSM path, and SES is pinned to the from-address.
  - The alarms exist.
  - Production and staging differ only in names, `TRADING_ENV` and SSM paths.
- **Live (fast, no cron waits):** `npm run invoke` runs the deployed staging Lambda on demand. Heartbeat, sync-broker and notify-urgent are each verified in seconds, and `notify:test` sends through SES.

## Boundaries

- **Always:** keep `@trader/core` platform-free; least-privilege IAM per environment; every resource in CDK (no console-created resources except the one-time bootstrap and DNS records); tag resources `app=trader`, `env=<env>`.
- **Ask first:** anything with a standing cost (NAT gateway, RDS, provisioned concurrency, Secrets Manager); leaving the SES sandbox; adding a second region.
- **Never:** long-lived AWS access keys in GitHub; letting staging's role read production parameters; deleting a Cloudflare Worker before its AWS replacement is confirmed claiming slots.

## Success Criteria

1. Gate green, including handler and infra assertion tests; `cdk synth` succeeds in CI on every push.
2. `TraderStaging` deployed from CI via OIDC. `npm run invoke` runs heartbeat, sync-broker and notify-urgent successfully, and the Function URL `/healthz` returns 200 `"env":"staging"`.
3. SES: domain verified (DKIM CNAMEs in Cloudflare), owner address verified, and staging `notify:test` arrives in Gmail from `trader@whitebirch.io`.
4. With both platforms running for at least one tick, each `(job, slot)` has exactly one `job_runs` row. Then the Cloudflare staging Worker is deleted.
5. `TraderProduction` deployed from `main`: health 200 `"env":"production"`, production `notify:test` arrives, Cloudflare production Worker deleted, and `wrangler` and `CLOUDFLARE_API_TOKEN` removed.
6. The alarms are confirmed. SNS email subscription confirmed; the error alarm fires on a forced failing invocation (staging) and recovers.
7. AWS Cost Explorer shows about $0 after the first full week. Trader's resources are tagged `app=trader`.

## Resolved Questions (2026-10-31)

1. **AWS credentials:** a CLI profile **`whitebirch`**, through **IAM Identity Center** (SSO) with an `AdministratorAccess` permission set. That gives short-lived credentials, refreshed with `aws sso login --profile whitebirch`. No root access keys. All commands, scripts and CDK use `--profile whitebirch` locally. CI uses the OIDC role, not this profile.
2. **Alarm email:** CloudWatch → SNS → `scott.schmalz@gmail.com`, kept separate from Trader's own email path, so alarms still arrive if Trader's email breaks.
