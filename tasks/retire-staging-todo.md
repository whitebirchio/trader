# Todo: retire the staging environment

> Plan: `tasks/retire-staging-plan.md`. Decision: ADR-018. Gate for every code task: `npm run typecheck && npm test`. T2, the import in T3, and T6 are Scott's: they delete or adopt AWS resources.

### T1: Retain the SES identities (small PR)
- [ ] `infra/lib/engine-stack.ts`: `applyRemovalPolicy(RemovalPolicy.RETAIN)` on `MailDomain` and `OwnerAddress`; an infra test pins `DeletionPolicy: Retain`.
- [ ] Push. CI deploys it to staging (the last staging deploy). Check that the deployed `TraderStaging` template has `DeletionPolicy: Retain` on both.
- [ ] Merge. Production's stack doesn't own the identities yet, so its deploy changes nothing.

### T2: Destroy `TraderStaging` (Scott, from `main` after T1)
- [ ] `npx cdk destroy TraderStaging --profile whitebirch` (CloudFront takes a while).
- [ ] `aws sesv2 get-email-identity --email-identity whitebirch.io --profile whitebirch` still shows it verified, and so does the owner's address.
- [ ] Don't push other branches until T3 is merged: an older `ci.yml` would deploy staging again.

### T3: Stop deploying staging; `TraderProduction` adopts the SES identities (small PR)
- [ ] `.github/workflows/ci.yml`: drop `deploy-staging`. Update the header comment to ADR-018.
- [ ] `infra/bin/trader.ts`: drop `TraderStaging`. `TraderProduction` owns the identities (`ownsSesIdentities: true`, still `RETAIN`). Drop the `deploy:staging` and `diff:staging` scripts.
- [ ] `infra/test/engine-stack.test.ts`: every assertion made against production only, including the SES identities and `DeletionPolicy: Retain`.
- [ ] Claude prepares the import from the branch's `cdk synth` and production's deployed template (`aws cloudformation get-template`): that template plus the two `AWS::SES::EmailIdentity` resources under their synthesized logical IDs, and the resources-to-import list (`EmailIdentity` = `whitebirch.io` and the owner's address). Nothing else changes in it.
- [ ] Scott: `aws cloudformation create-change-set --change-set-type IMPORT …`, review it (two imports, no other changes), then execute it.
- [ ] Merge. Production's deploy finds both identities already in the stack and only updates what the build changed.
- [ ] `npm run notify:test -w @trader/core -- --env production`, then `npm run invoke -- --env production --jobs notify-urgent`: the test email arrives.

### T4: The migration check and core
- [ ] `ci.yml`, a `migrate-check` job for pushes to branches other than `main`:
  - create a temporary branch of production, schema-only if Neon's API allows it (fallback: a full branch with the migrate output suppressed);
  - run `npm run db:migrate` against it;
  - delete it in an `always()` step.
- [ ] Repo secret `NEON_API_KEY` and variable `NEON_PROJECT_ID` (Scott sets them; the key is never echoed).
- [ ] Acceptance: the PR's push runs `build` and `migrate-check` and no deploy, and its temporary branch is gone afterwards (Neon console).
- [ ] Core: remove #109's staging special cases:
  - the `earnings-calendar` skip;
  - `BACKFILL.perDay` becomes one number.

### T5: Laptop scripts, Claude's checks, docs
- [ ] `scripts/ops.ts`: `--env production` only. The scripts that need staging's database get a paper rehearsal instead, on a throwaway PGlite database with the paper keys:
  - `broker:smoke`: the $5 VTI buy, fill, lot and audit checks;
  - `rebalance:run`: sync the paper account, submit a strategy file, run one real step.
- [ ] `risk:status`, `strategy:show`, `capital:status` and `scorecard:show` open the dashboard's SELECT-only role (its URL read from SSM `/trader/production/DATABASE_READ_URL` with the laptop's AWS profile, so no copy goes in `.env`) and fetch market data through the paper keys: no owner role, no live key. A test or a check confirms that a write through that connection is refused.
- [ ] Claude Code's local settings (`.claude/settings.local.json`, not committed) allow exactly those four with `--env production`.
- [ ] CLAUDE.md:
  - the environments table;
  - every `--env staging` command;
  - "verify on demand", now production and the paper rehearsal;
  - Boundaries: drop "resetting the staging Neon branch", keep "let staging config reach a live account", and add an Always: the paper rehearsal for changes to `src/broker/`, `src/risk/`, `src/portfolio/rebalance.ts` or the order intents.
- [ ] `docs/SETUP.md` (staging rows, the reset section, DNS, OAuth, SES now in `TraderProduction`), SPEC-platform-aws, SPEC-dashboard, SPEC-notifications, SPEC-agent (#109's rows), `docs/research/README.md`.
- [ ] `docs/decisions/README.md`: ADR-018 Accepted; 005 and 006 "Superseded by 018". ADR-018's status becomes Accepted.
- [ ] Claude's memory: retire "staging holds one branch"; update "verify fast" to production and the paper rehearsal.

### T6: Clean up (Scott, after T5 merges)
- [ ] Neon: delete the `staging` branch.
- [ ] AWS: delete the `/trader/staging/` parameters, plus any log groups or alarm subscriptions the destroy left behind.
- [ ] GitHub: delete the `STAGING_MIGRATE_URL` secret.
- [ ] Cloudflare: delete the `trader-staging` CNAME. The certificate keeps the name until it's next reissued.
- [ ] Google Cloud: remove the staging redirect URI from the "Trader" OAuth client.
- [ ] claude.ai: remove the "Trader (Staging)" connector.

### T7: Verify
- [ ] After T3: the production test email arrives, and `TraderProduction` lists both identities as resources.
- [ ] The first feature PR after T5 runs `migrate-check` green with a new migration, and deploys nothing until merge.
- [ ] The paper rehearsal runs end to end in market hours.
- [ ] Claude runs the four read-only checks against production without a permission prompt.
