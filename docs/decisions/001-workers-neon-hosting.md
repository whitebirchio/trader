# ADR-001: Host on Cloudflare Workers + Neon Postgres

## Status
Accepted

## Date
2026-10-31

## Context
Trader has to run unattended ("set and forget"), cost close to nothing at a $1k starting balance, and be maintainable by the same person and agents who maintain Corpus and Fred. The previous attempt (`~/src/trader-old`) used AWS CDK + Lambda + Turso, which became a second hosting stack to understand.

## Decision
Run on **Cloudflare Workers** (cron triggers for scheduled work, `nodejs_compat`) with **Neon Postgres** through `@neondatabase/serverless` and Drizzle, the same stack as Corpus and Fred.

## Alternatives Considered

### AWS Lambda + Turso (trader-old)
- Rejected: a separate stack (CDK, IAM, CloudWatch) to maintain for one project.

### A VPS or long-running process
- Rejected: patching and uptime become our problem, and it costs money every month.

## Consequences
- $0/mo on the Workers free plan and Neon free tier, until CPU-heavy work (likely `portfolio`) needs Workers Paid ($5/mo).
- Workers can't run Python or long computations, so analysis stays in TypeScript and is kept cheap.
- Conventions, deploy and debugging carry over directly from Corpus and Fred.
