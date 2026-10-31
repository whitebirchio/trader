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

## Local development

```sh
sed -n 's/^STAGING_MIGRATE_URL=//p' .env | tr -d "'\"" | sed 's/^/DATABASE_URL=/' > apps/engine/.dev.vars
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
