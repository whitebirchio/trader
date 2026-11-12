# Todo: retire the staging environment

> Plan: `tasks/retire-staging-plan.md`. Decision: ADR-018. Gate for every code task: `npm run typecheck && npm test`. T2 and T6 are Scott's: they delete resources.

### T1: Retain the SES identities (small PR)
- [ ] `infra/lib/engine-stack.ts`: `applyRemovalPolicy(RemovalPolicy.RETAIN)` on `MailDomain` and `OwnerAddress`; an infra test pins `DeletionPolicy: Retain`.
- [ ] Push. CI deploys it to staging (the last staging deploy). Check that the deployed `TraderStaging` template has `DeletionPolicy: Retain` on both.
- [ ] Merge. Production's stack doesn't own the identities, so its deploy is a no-op.

### T2: Destroy `TraderStaging` (Scott, from `main` after T1)
- [ ] `npx cdk destroy TraderStaging --profile whitebirch` (CloudFront takes a while).
- [ ] `aws sesv2 get-email-identity --email-identity whitebirch.io --profile whitebirch` still shows it verified.
- [ ] `npm run notify:test -w @trader/core -- --env production`, then `npm run invoke -- --env production --jobs notify-urgent`: the test email arrives.
- [ ] Don't push other branches until T3–T5 merge: an older `ci.yml` would deploy staging again.

### T3: CI
- [ ] Drop `deploy-staging` from `.github/workflows/ci.yml`. Update the header comment to ADR-018.
- [ ] Add `migrate-check` for pushes to branches other than `main`:
  - create a temporary branch of production, schema-only if Neon's API allows it (fallback: a full branch with the migrate output suppressed);
  - run `npm run db:migrate` against it;
  - delete it in an `always()` step.
- [ ] Repo secret `NEON_API_KEY` and variable `NEON_PROJECT_ID` (Scott sets them; the key is never echoed).
- [ ] Acceptance: the PR's own push runs `build` and `migrate-check` and no deploy, and the temporary branch is gone afterwards (Neon console).

### T4: Infra and core
- [ ] `infra/bin/trader.ts`:
  - drop `TraderStaging`;
  - `TraderProduction` no longer takes `ownsSesIdentities` (or keeps `false`, per open question 1);
  - drop the `deploy:staging` and `diff:staging` scripts.
- [ ] `infra/test/engine-stack.test.ts`: keep every assertion, made against production only.
- [ ] `npm run synth` lists `TraderCi`, `TraderCerts` and `TraderProduction`. `cdk diff TraderProduction` shows no changes.
- [ ] Core: remove #109's staging special cases:
  - the `earnings-calendar` skip;
  - `BACKFILL.perDay` becomes one number.

### T5: Laptop scripts and docs
- [ ] `scripts/ops.ts`: `--env production` only. The scripts that need staging's database get a paper rehearsal instead, on a throwaway PGlite database with the paper keys:
  - `broker:smoke`: the $5 VTI buy, fill, lot and audit checks;
  - `rebalance:run`: sync the paper account, submit a strategy file, run one real step.
- [ ] CLAUDE.md:
  - the environments table;
  - every `--env staging` command;
  - "verify on demand";
  - Boundaries: drop "resetting the staging Neon branch", keep "let staging config reach a live account", and add an Always: the paper rehearsal for order-path changes.
- [ ] `docs/SETUP.md` (staging rows, the reset section, DNS, OAuth), SPEC-platform-aws, SPEC-dashboard, SPEC-notifications, SPEC-agent (#109's rows), `docs/research/README.md`.
- [ ] `docs/decisions/README.md`: ADR-018 Accepted; 005 and 006 "Superseded by 018". ADR-018's status becomes Accepted.
- [ ] Claude's memory: retire "staging holds one branch"; update "verify fast" to production and the paper rehearsal.

### T6: Clean up (Scott, after T3–T5 merge)
- [ ] Neon: delete the `staging` branch.
- [ ] AWS: delete the `/trader/staging/` parameters, plus any log groups or alarm subscriptions the destroy left behind.
- [ ] GitHub: delete the `STAGING_MIGRATE_URL` secret.
- [ ] Cloudflare: delete the `trader-staging` CNAME.
- [ ] Google Cloud: remove the staging redirect URI from the "Trader" OAuth client.
- [ ] claude.ai: remove the "Trader (Staging)" connector.

### T7: Verify
- [ ] The merge's production deploy succeeds with no change to `TraderProduction`'s resources.
- [ ] The first feature PR after it runs `migrate-check` green with a new migration, and deploys nothing until merge.
- [ ] The paper rehearsal runs end to end in market hours.
