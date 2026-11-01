# Tasks: `dashboard`

> Plan: [dashboard-plan.md](dashboard-plan.md) · Spec: [SPEC-dashboard.md](../SPEC-dashboard.md) · gate = typecheck + test (+ synth)

- [ ] D1: spike. A minimal Next app on a Web Function plus CloudFront and OAC in staging: start contract, OAC behaviour, cold start, billing. **Decision: Web Functions or the fallback.** Then remove it.
- [ ] D2: `benchmark_closes` (additive migration) + after-close VTI recording + one-time backfill; tests
- [ ] D3: core read models: `overviewView`, `performanceSeries`, `holdingsView`, `strategyView` + `strategyHistory`, `activityView`; tests
- [ ] D4: `db:dashboard-role` (SELECT-only; INSERT check) + `scripts/set-dashboard-secrets.sh`
- [ ] D5: `apps/dashboard` shell: Next 16 + Tailwind 4, Google OIDC (PKCE/state/nonce, claims, owner allow-list), signed session, middleware, CSP; tests
- [ ] D6: pages: overview + chart, holdings, strategy + history, activity; staging banner; PWA manifest and icons
- [ ] D7: infra `dashboard` construct: Web Function + revision + endpoint (maxEnvironments 1, rate limit), role (3 SSM params only), CloudFront (OAC, CachingDisabled), ACM cert; assertions
- [ ] D8: *(Scott)* Google OAuth client + Cloudflare DNS; staging deploy; verify SC-2, 3, 4, 6
- [ ] D9: production PR → merge → DNS → verify SC-5; CAPABILITY-MAP + SETUP.md updated
