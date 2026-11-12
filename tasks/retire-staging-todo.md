# Todo: retire the staging environment

> Plan: `tasks/retire-staging-plan.md`. Decision: ADR-018 (Accepted). Gate for every code task: `npm run typecheck && npm test`. T2, the import in T3, and T6 are Scott's: they delete or adopt AWS resources.

### T1: Retain the SES identities (small PR)
- [x] `infra/lib/engine-stack.ts`: `applyRemovalPolicy(RemovalPolicy.RETAIN)` on `MailDomain` and `OwnerAddress`; an infra test pins `DeletionPolicy: Retain` (#111).
- [x] Push. CI deploys it to staging (the last staging deploy). Check that the deployed `TraderStaging` template has `DeletionPolicy: Retain` on both. (2026-11-11: the first deploy was cancelled; rerun, then both showed `Retain` for deletion and replacement.)
- [x] Merge. Production's stack doesn't own the identities yet, so its deploy changes nothing.

### T2: Destroy `TraderStaging` (Scott, from `main` after T1)
- [x] `npx cdk destroy TraderStaging --profile whitebirch` (CloudFront takes a while). Done 2026-11-11, with `--force` (the `!` shell has no TTY).
- [x] `aws sesv2 get-email-identity --email-identity whitebirch.io --profile whitebirch` still shows it verified, and so does the owner's address.
- [x] Don't push other branches until T3 is merged: an older `ci.yml` would deploy staging again.

### T3: Stop deploying staging; `TraderProduction` adopts the SES identities (small PR)
- [x] `.github/workflows/ci.yml`: drop `deploy-staging`. Update the header comment to ADR-018.
- [x] `infra/bin/trader.ts`: drop `TraderStaging`. `EngineStack` always owns the identities (the `ownsSesIdentities` prop is gone; still `RETAIN`). `deploy:staging` dropped; `diff:staging` became `diff:production`.
- [x] `infra/test/engine-stack.test.ts`: every assertion made against production only, including the SES identities and `DeletionPolicy: Retain`.
- [x] Claude prepares the import from the branch's `cdk synth` and production's deployed template (`aws cloudformation get-template`): that template plus the two `AWS::SES::EmailIdentity` resources under their synthesized logical IDs, and the resources-to-import list (`EmailIdentity` = `whitebirch.io` and the owner's address). Nothing else changes in it.
- [x] Scott: `aws cloudformation create-change-set --change-set-type IMPORT …`, review it (two imports, no other changes), then execute it. `IMPORT_COMPLETE` 2026-11-11.
- [x] Merge (#112). Production's deploy finds both identities already in the stack and only updates what the build changed.
- [x] `npm run notify:test -w @trader/core -- --env production`, then `npm run invoke -- --env production --jobs notify-urgent`: the test email arrives (`sent: 1`; DKIM still `SUCCESS`).

### T4: The migration check and core
- [x] `ci.yml`, a `migrate-check` job for pushes to branches other than `main` (`scripts/ci-migrate-check.sh`, Neon's API directly, so no connection string passes through step outputs or env):
  - create a temporary copy-on-write branch of production, expiring in 2 hours. Not schema-only after all: a schema-only branch has no rows, so Drizzle's migration journal would be empty and every migration would rerun. The migrate output is suppressed instead;
  - run `npm run db:migrate` against it, printing only pass or fail;
  - delete it on exit.
- [x] Repo secret `NEON_API_KEY` and variable `NEON_PROJECT_ID` (Scott sets them; the key is never echoed).
- [x] Acceptance: the PR's push runs `build` and `migrate-check` and no deploy, and its temporary branch is gone afterwards (Neon console).
- [x] Core: remove #109's staging special cases:
  - the `earnings-calendar` skip;
  - `BACKFILL.perDay` becomes one number.

### T5: Laptop scripts, Claude's checks, docs
- [x] `scripts/ops.ts`: `--env production|paper` (`staging` is refused with a pointer to `paper`). Paper is the rehearsal: the paper keys and a local PGlite database in `.cache/paper-db`, kept between commands and rebuilt when the migrations change:
  - `broker:smoke`: the $5 VTI buy, fill, lot and audit checks;
  - `rebalance:run`: sync the paper account, submit a strategy file, run one real step.
- [x] `risk:status`, `strategy:show`, `capital:status` and `scorecard:show` open `trader_readonly`, a SELECT-only role (its URL read from SSM `/trader/production/READONLY_DATABASE_URL` with the laptop's AWS profile, so no copy goes in `.env`). The plan said the dashboard's role, but that role can INSERT into `capital_commands` (the withdrawal button), and the catalog check refused it on the first run, 2026-11-11. So the checks got a role of their own (`scripts/set-readonly-secret.sh`, Scott runs it) and fetch market data through the paper keys: no owner role, no live key. `withReadOnly` checks the role's privileges in the catalog (`writableTables`, tested) and refuses a connection that could change any table.
- [x] Claude Code's local settings (`.claude/settings.local.json`, not committed) allow exactly those four with `--env production` (Scott, 2026-11-11, through `/permissions`).
- [x] CLAUDE.md:
  - the environments table;
  - every `--env staging` command;
  - "verify on demand", now production and the paper rehearsal;
  - Boundaries: drop "resetting the staging Neon branch", keep "let staging config reach a live account", and add an Always: the paper rehearsal for changes to `src/broker/`, `src/risk/`, `src/portfolio/rebalance.ts` or the order intents.
- [x] `docs/SETUP.md` (staging rows, the reset section, DNS, OAuth, SES now in `TraderProduction`), SPEC-platform-aws, SPEC-dashboard, SPEC-notifications, SPEC-agent (#109's rows), `docs/research/README.md`. Specs with old `--env staging` commands get an ADR-018 note at the top; their records of staging checks stay as written.
- [x] `docs/decisions/README.md`: ADR-018 Accepted; 005 and 006 "Superseded by 018". ADR-018's status becomes Accepted.
- [x] Claude's memory: retire "staging holds one branch"; update "verify fast" to production and the paper rehearsal.

### T6: Clean up (Scott, after T5 merges)
- [x] Neon: delete the `staging` branch.
- [x] AWS: delete the `/trader/staging/` parameters, plus any log groups or alarm subscriptions the destroy left behind. 13 parameters and 2 log groups; no schedules, alarms or topics remained.
- [x] GitHub: delete the `STAGING_MIGRATE_URL` secret.
- [x] Cloudflare: delete the `trader-staging` CNAME. The certificate keeps the name until it's next reissued.
- [x] Google Cloud: remove the staging redirect URI from the "Trader" OAuth client.
- [x] claude.ai: remove the "Trader (Staging)" connector.

### T7: Verify
- [x] After T3: the production test email arrives, and `TraderProduction` lists both identities as resources (2026-11-11).
- [ ] The first feature PR after T5 runs `migrate-check` green with a new migration, and deploys nothing until merge.
- [ ] The paper rehearsal runs end to end in market hours.
- [x] Claude runs the four read-only checks against production without a permission prompt (2026-11-11, through `trader_readonly`, after #114).
