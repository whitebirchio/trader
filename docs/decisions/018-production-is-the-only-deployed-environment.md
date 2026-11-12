# ADR-018: Production is the only deployed environment; paper is a local tool

## Status
Accepted (Scott, 2026-11-11, with [tasks/retire-staging-plan.md](../../tasks/retire-staging-plan.md); built in #111, #112 and the PR that closes T4–T5). Supersedes ADR-005 (paper is staging) and ADR-006 (branch-based deploys). ADR-005's guard that no staging config reaches a live account stands.

## Date
2026-11-11

## Context
ADR-005 made the paper account a deployed staging environment, "a place to try logic before it touches real money". ADR-006 deployed every feature branch to it, so changes would soak on paper before a merge shipped them to live money.

In practice nothing soaks. Scott merges once a PR is reviewed and green. Staging's real use is a few minutes of on-demand checks after each branch deploy (an `invoke`, a staging MCP call), and then the merge. Meanwhile it costs:
- **A deploy on every push.** Plus the rule that staging holds one branch at a time, so parallel branches have to be sequenced.
- **A second copy of everything:** a CDK stack, a Neon branch, a set of SSM secrets, a dashboard name, a claude.ai MCP connector and an alarm topic.
- **Diverging behaviour.** The free Alpha Vantage key's 25 requests a day serve both environments, so #109 had to make staging skip the earnings calendar and the earnings backfill. Each special case like that makes staging a worse rehearsal of production.
- **Data that drifts.** Staging's database, strategy and paper positions have their own history, so a check there says less and less about production.

Two things now do staging's job better:
- **The replay harness** (#57) runs Trader's real jobs over years of daily bars with a simulated broker. It tests strategy and risk behaviour far better than days on paper.
- **Tests on PGlite** run the real migrations and every core job.

## Decision
- **Production is the only deployed environment.** `TraderStaging`, the Neon `staging` branch, `/trader/staging/`, `trader-staging.whitebirch.io` and the staging MCP connector are retired.
- **CI:**
  - every push builds and tests, as now;
  - a push to any branch other than `main` also checks its migrations against a temporary Neon branch made from production (schema only, if Neon allows it), deleted when the run ends;
  - a push or merge to `main` migrates and deploys production, as now.
- **The paper account stays, as a tool rather than an environment:**
  - **Market data:** the production MCP server, the research scripts and the replay already fetch it through paper keys.
  - **Order-path rehearsal:** changes to the broker adapter, order submission, the rebalance or risk are tried on the paper account from the laptop, against a throwaway local database, before merge.
- **`TRADING_ENV` keeps both values.** `staging` now means "not live": the replay and the laptop's paper scripts use it. Nothing deploys with it.
- **Verification moves:**
  - **Before merge:** it happens locally (tests, replay, the paper rehearsal, live API checks by script).
  - **After merge:** it happens in production, through on-demand runs, which are idempotent per slot (ADR-007), and read-only checks.

## Alternatives Considered

### Keep staging as it is
- Rejected: the soak it exists for doesn't happen, and its overhead and drift keep growing.

### Keep staging deployed, but unscheduled (on-demand only)
- Rejected: it removes the drift in behaviour but keeps the deploys, the secrets, the one-branch rule and the second connector. Its data drifts further from production with nothing exercising it.

### Retire staging with no migration check
- Rejected: migrations auto-apply to production on merge, and staging is today the only place they meet a real Neon database first. A temporary branch is cheap and checks production's actual schema, which staging's drifted copy doesn't.

## Consequences
- **Changes reach real money with no deployed rehearsal.** What stands in for one:
  - the PGlite tests with the real migrations;
  - the migration check;
  - the replay;
  - the paper rehearsal for order-path changes;
  - risk's limits, the kill switch and additive-only migrations.
- **Order-path changes need a deliberate step.** The paper rehearsal becomes an "Always" in CLAUDE.md for `src/broker/`, `src/risk/`, `src/portfolio/rebalance.ts` and the order intents, instead of something that happens by default.
- **Claude's checks after a deploy run against production.** Scott allows four read-only status scripts, which connect through the dashboard's SELECT-only role and paper market data, so they can't write or trade. Other production reads stay his to run.
- **The SES identities move to `TraderProduction`.** `TraderStaging` owns them (they're account-wide), and production sends through them. They're retained when staging is destroyed, then imported into `TraderProduction`, so CDK still manages them (Scott, 2026-11-11).
- **Less to run:**
  - one deploy per merge;
  - no one-branch-at-a-time rule;
  - one set of secrets and one MCP connector;
  - every Alpha Vantage request available to production.
