# Plan: retire the staging environment

> **Status: Built** (2026-11-11 to 11-12: #110, #111, #112, #113, #114, the destroy, the SES import and the cleanup). Decision: [ADR-018](../../docs/decisions/018-production-is-the-only-deployed-environment.md). Tasks: `tasks/done/retire-staging-todo.md`. One check remains, and it happens by itself: the first PR that adds a migration runs `migrate-check` on it.

## Why
Scott, 2026-11-11: nothing soaks on staging before release, so it's only overhead, and it has started to behave differently from production (#109 made it skip Alpha Vantage). The reasoning is in ADR-018.

## Decisions
- **Retire the deployed environment, keep the paper account.** The paper keys already serve market data to the production MCP server, the research scripts and the replay. They now also serve a laptop rehearsal for order-path changes.
- **The SES identities move into `TraderProduction`, still managed by CDK** (Scott, 2026-11-11).
  - **Why they need care:** `TraderStaging` creates the two account-wide SES identities (`whitebirch.io` and the owner's address), and production's email goes through them. Destroying the stack as it stands deletes them, which would stop production email and change the DKIM records.
  - **How they move:**
    1. They're marked `RETAIN` and deployed to staging.
    2. Staging is destroyed, and they stay behind.
    3. `TraderProduction` imports them.

    The import is a CloudFormation `IMPORT` change set built from production's deployed template plus the two resources. That's not `cdk import` from the laptop, because a local dashboard build wouldn't match the deployed asset hashes, and an import can't carry other changes.
- **The migration check uses a schema-only branch where possible.** The repo is public, and so are its CI logs. A copy of production with data could print a holding in a failed migration's error (a duplicate-key message names the key, for example). A schema-only branch can't. If Neon's API doesn't offer one, the fallback is a full branch with the migrate step's output suppressed. Data-dependent failures, such as a `NOT NULL` on a table with rows, are already ruled out by the additive-migrations rule.
- **Claude may run four read-only production checks** (Scott, 2026-11-11): `risk:status`, `strategy:show`, `capital:status` and `scorecard:show`.
  - **Read-only by construction:** first they're made read-only by how they connect, not just by what they happen to do. They switch to a SELECT-only database role of their own, `trader_readonly` (today they use the owner role; the dashboard's role turned out to have one write, `INSERT` on `capital_commands`), and to market data through the paper keys (`capital:status` builds a live-key broker today).
  - **Then the permissions:** those four commands, with `--env production`, are allowed in Claude Code's local settings. Their output stays in the conversation and is never published.
- **Unchanged:**
  - **The paper account's positions** stay as they are. They're test leftovers, and nothing reads them.
  - **The dashboard certificate** keeps its `trader-staging` name until it's next reissued, when the name is dropped.
- **`TRADING_ENV=staging` stays** as the "not live" value (replay, laptop paper scripts). The guard that keeps staging config off a live account stays.
- **Order matters.** In order:
  1. Retain the SES identities.
  2. Destroy the stack, from a checkout that still defines it.
  3. Stop deploying staging and import the identities.
  4. The rest.

  Between steps 2 and 3, don't push any other branch: CI reads `ci.yml` from the pushed branch, and an older one would deploy staging again.

## Phases
1. **Decision (this PR):** ADR-018, this plan and its todo.
2. **Retain SES (T1, a small PR):** `RETAIN` on the two identities. Its push is the last staging deploy. Merging it changes nothing in production.
3. **Tear down the stack (T2, Scott):** `cdk destroy TraderStaging`, then check that the identities are still verified.
4. **Stop deploying staging and adopt SES in production (T3, a small PR):**
   - CI drops `deploy-staging`.
   - Infra drops `TraderStaging`, and `TraderProduction` defines the identities.
   - Before merge, Scott runs the import change set Claude prepares, so the merge's deploy finds them already in the stack.
5. **The rest (T4–T5, one PR):**
   - the migration check in CI;
   - removing #109's staging special cases from core;
   - the read-only checks and their permissions;
   - the paper rehearsal on a local database;
   - the docs and the ADR index.
6. **Clean up (T6, Scott):** delete the Neon branch, the SSM path, the GitHub secret, the DNS name, the OAuth redirect and the claude.ai connector.
7. **Verify (T7):**
   - production email after the import;
   - production's deploys succeed;
   - the next feature PR runs the migration check and deploys nothing until merge.

## Not changing
- Production's schedules, limits, routine and notifications.
- The paper and live keys.
- The guard that no staging config reaches a live account.
- How `main` deploys.
