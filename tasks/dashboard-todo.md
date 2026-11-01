# Tasks: `dashboard`

> Plan: [dashboard-plan.md](dashboard-plan.md) · Spec: [SPEC-dashboard.md](../SPEC-dashboard.md) · gate = typecheck + test (+ synth)

- [x] D1: spike (2026-11-01): **Web Functions**; findings in the spec. A minimal Next app on a Web Function plus CloudFront and OAC in staging: start contract, OAC behaviour, cold start, billing. **Decision: Web Functions or the fallback.** Then remove it.
- [x] D2: `benchmark_closes` (additive migration) + after-close VTI recording + one-time backfill; tests
- [x] D3: core read models: `overviewView`, `performanceSeries`, `holdingsView`, `strategyView` + `strategyHistory`, `activityView`; tests
- [x] D4: `db:dashboard-role` (SELECT-only; INSERT check) + `scripts/set-dashboard-secrets.sh`
- [x] D5: `apps/dashboard` shell: Next 16 + Tailwind 4, Google OIDC (PKCE/state/nonce, claims, owner allow-list), signed session, middleware, CSP; tests
- [x] D6: pages: overview + chart, holdings, strategy + history, activity; staging banner; PWA manifest and icons
- [x] D7: infra: `TraderCerts` stack (one ACM certificate for both names; deployed first, then DNS-validated) + `dashboard` construct: versioned code bucket + BucketDeployment, Web Function + revision + IamAuth endpoint (maxEnvironments 2, rate limit), resource policy (this distribution only), role (3 SSM params only), both log groups (30 days), CloudFront (OAC lambda/always-amz-auth, CachingDisabled, AllViewerExceptHostHeader); assertions
- [x] D8: *(Scott)* Google OAuth client + Cloudflare DNS; staging deploy; verified 2026-11-01: owner signs in (log: "signed in"), pages match risk:status/strategy:show, raw endpoint 403, role can't write. Found + fixed: `+` in query strings broke OAC (CloudFront Function). SC-6 (home screen) is Scott's to try on his phone
- [ ] D9: production PR → merge → DNS → verify SC-5; CAPABILITY-MAP + SETUP.md updated
