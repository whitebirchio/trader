# ADR-014: Run the engine on AWS with CDK; keep Neon and Cloudflare DNS/inbound mail

## Status
Accepted (supersedes ADR-001)

## Date
2026-11-01

## Context
ADR-001 put the engine on Cloudflare Workers to match Corpus and Fred. Specifying `portfolio` showed the free plan's 10 ms of CPU per invocation was too tight to rank a year of bars for up to 100 symbols. The options were Workers Paid ($5/mo), engineering around the limit, or moving. Scott already pays for AWS, knows it better, and prefers one bill and the room to grow without tiptoeing around plan limits.

## Decision
Run the engine on **AWS in Scott's existing account, `us-east-1`, with every resource defined in CDK** (`infra/`):

- **Scheduled jobs:** EventBridge Scheduler (every 15 min) → a Node 22 arm64 Lambda per environment (`trader-engine-staging` / `-production`), which passes the scheduled time for slot idempotency (ADR-007).
- **Health:** a public Lambda Function URL serving `/healthz` only.
- **Secrets:** SSM Parameter Store SecureStrings under `/trader/<env>/`. Each environment's role can read only its own path.
- **Email:** SES, kept in the sandbox (only verified recipients), with the from-address pinned to `trader@whitebirch.io` in IAM.
- **Alarms:** CloudWatch → SNS → owner email, for Lambda errors and for "no invocation in an hour".
- **Deploys:** GitHub Actions assumes `trader-github-deploy` through OIDC, trusting the repo's immutable subject (org and repo IDs). The role can only assume CDK's bootstrap roles. Branch routing is unchanged (ADR-006).

**What stays:** Neon Postgres (free, same schema and roles), and Cloudflare for whitebirch.io's DNS and inbound Email Routing (free). Trader itself no longer runs anything on Cloudflare.

## Alternatives Considered

### Stay on Cloudflare free (weekly bars, a separate cron trigger)
- Viable at $0, measured at ~5–6 ms. Rejected: it keeps engineering against a hard limit, and Scott prefers AWS.

### Workers Paid ($5/mo)
- Rejected: a new bill on a platform Scott is less familiar with.

### Move only `rebalance` to Lambda
- Rejected: two compute platforms to operate.

### RDS / Aurora instead of Neon
- Rejected: RDS is ~$12–15/mo after the free tier, and Aurora Serverless never sleeps on a 15-minute schedule.

## Consequences
- AWS cost is ≈ $0, inside the always-free tier (Lambda, Scheduler, SSM standard, CloudWatch, SNS), plus fractions of a cent for SES.
- `@trader/core` didn't change. The move replaced only the app shell (`apps/lambda`) and the pipeline (ADR-002).
- Cutover had no gap: both platforms ran side by side, and the shared `(job, slot)` claim meant exactly one ran each job.
- `agent` (MCP server) and `dashboard` will be designed for AWS too: Lambda + Function URL with its own OAuth, and S3 + CloudFront.
- One-time owner steps (bootstrap, `TraderCi`, SES/SNS confirmations, DKIM records) are in `docs/SETUP.md`.
