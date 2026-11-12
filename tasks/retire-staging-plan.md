# Plan: retire the staging environment

> **Status: Proposed** (2026-11-11), for Scott's review. Decision: [ADR-018](../docs/decisions/018-production-is-the-only-deployed-environment.md). Tasks: `tasks/retire-staging-todo.md`.

## Why
Scott, 2026-11-11: nothing soaks on staging before release, so it's only overhead, and it has started to behave differently from production (#109 made it skip Alpha Vantage). The reasoning is in ADR-018.

## Decisions
- **Retire the deployed environment, keep the paper account.** The paper keys already serve market data to the production MCP server, the research scripts and the replay. They now also serve a laptop rehearsal for order-path changes.
- **The SES identities survive.** `TraderStaging` creates the two account-wide SES identities (`whitebirch.io` and the owner's address), and production's email goes through them. Destroying the stack as it stands deletes them, which would stop production email and change the DKIM records. So they're marked `RETAIN` and deployed to staging before anything is destroyed.
- **The migration check uses a schema-only branch where possible.** The repo is public, and so are its CI logs. A copy of production with data could print a holding in a failed migration's error (a duplicate-key message names the key, for example). A schema-only branch can't. If Neon's API doesn't offer one, the fallback is a full branch with the migrate step's output suppressed. Data-dependent failures, such as a `NOT NULL` on a table with rows, are already ruled out by the additive-migrations rule.
- **`TRADING_ENV=staging` stays** as the "not live" value (replay, laptop paper scripts). The guard that keeps staging config off a live account stays.
- **Order matters.** In order:
  1. Retain the SES identities.
  2. Destroy the stack, from a checkout that still defines it.
  3. Merge the code change that stops deploying it.

  A branch pushed before step 3 lands would recreate staging. Step 3's own push doesn't, because CI reads `ci.yml` from the pushed branch.

## Phases
1. **Decision (this PR):** ADR-018 (Proposed), this plan and its todo. Scott accepts or changes them.
2. **Keep SES alive (T1, a small PR):** `RemovalPolicy.RETAIN` on the two identities. Its push is the last staging deploy. Merging it changes nothing in production.
3. **Tear down the stack (T2, Scott):** run `cdk destroy TraderStaging` from the laptop. Check that the identities are still verified and that a production test email arrives.
4. **Code, CI and docs (T3–T5, one PR):**
   - CI drops `deploy-staging` and gains the migration check.
   - Infra drops `TraderStaging`.
   - Core drops #109's staging special cases.
   - The laptop scripts get a paper rehearsal on a local database.
   - The docs and the ADR index are updated.
5. **Clean up (T6, Scott):** delete the Neon branch, the SSM path, the GitHub secret, the DNS name, the OAuth redirect and the claude.ai connector.
6. **Verify (T7):**
   - production's deploy of phase 4 is a no-op for its stack;
   - the migration check ran on phase 4's branch;
   - the next feature PR's check passes too.

## Open questions for Scott
1. **The SES identities after the teardown:** leave them unmanaged and documented in SETUP.md (simplest; they never change), or `cdk import` them into `TraderProduction` (they stay in code; an interactive laptop step)? Recommendation: leave them unmanaged.
2. **The paper account's positions** (from staging's strategy): leave them, or liquidate them by hand in Alpaca? They don't affect anything either way.
3. **Claude's checks after a deploy:**
   - Production reads are blocked for Claude today, so after this most checks after a merge are Scott's to run.
   - Allowing a short list of read-only scripts (`risk:status`, `strategy:show`, `capital:status`, `scorecard:show`) would keep the loop as fast as it is on staging.
   - Their output stays in the conversation and is never published, which matches the current rule.
4. **The dashboard certificate** also covers `trader-staging.whitebirch.io`. Leave it (harmless; reissuing needs DNS validation again) or reissue it later? Recommendation: leave it.

## Not changing
- Production's stack, schedules, limits, routine and notifications.
- The paper and live keys.
- The guard that no staging config reaches a live account.
- How `main` deploys.
