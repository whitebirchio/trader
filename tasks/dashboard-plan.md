# Implementation Plan: `dashboard`

> Implements [SPEC-dashboard.md](../SPEC-dashboard.md) (approved 2026-11-01). Tasks are in [dashboard-todo.md](dashboard-todo.md).

## Order
1. **D1, spike** (staging only, then thrown away): a minimal Next.js standalone app on a Web Function from CDK, with CloudFront and OAC in front. It answers spec open question 4:
   - the start command and how the port is passed (`AWS_LAMBDA_HTTP_ENDPOINT`);
   - whether OAC refuses the raw URL;
   - the cold-start time;
   - what the billing line shows.

   **Decision point:** Web Functions, or the fallback (Lambda Web Adapter on a regular function).
2. **D2, prices** (core): the `benchmark_closes` migration. `sync-broker`'s after-close phase records VTI's close, with a one-year backfill on its first run. This can run in parallel with D1.
3. **D3, read models** (core `src/dashboard/`): overview, performance series, holdings, strategy and history, activity. They read the database only.
4. **D4, roles and secrets:**
   - `db:dashboard-role` creates `trader_dashboard` with SELECT only, and checks that an INSERT fails;
   - `set-dashboard-secrets.sh` writes the session key and the Google secret to SSM.
5. **D5, app shell and auth** (`apps/dashboard`): Next 16, Tailwind 4, Google OIDC, the signed session, the middleware and security headers.
6. **D6, pages:** the four pages, the chart, the staging banner and the PWA manifest.
7. **D7, infra:** the dashboard construct (Web Function, revision, endpoint, role, CloudFront, ACM certificate) with assertions.
8. **D8, staging live:** Scott creates the Google client and adds the DNS records; then deploy and verify.
9. **D9, production:** PR, merge, DNS, verify.

## Checkpoints
- **After D1:** report the hosting decision and anything the spec got wrong. This is the only point where the plan might change shape.
- **After D4:** the core and database changes are green. They're additive and safe to merge to production by themselves, if that helps.
- **After D7:** `synth` bundles the app, and the gate is green.
- **After D8:** success criteria 2, 3, 4 and 6 are verified on staging.

## Key decisions
- **Read models live in core** and are DB-only. They reuse `thesisStates`, `buildIndex` and `compareToBenchmark` rather than copying them.
- **The VTI close is recorded by the engine,** so the dashboard never needs broker keys.
- **The app is a thin shell:** a server component calls a read model and renders it. Only the chart is client-side.
- **Infra stays in `EngineStack`,** as a construct per environment, so staging and production remain identical apart from names. That's what the existing infra tests assert.

## Risks
| Risk | Mitigation |
|---|---|
| Web Functions behave differently from the docs (they're new, and the L1 constructs are thinly documented) | D1 runs first. The fallback is known to work and leaves the rest of the plan unchanged. |
| OAC isn't supported for Web Function origins | Keep `ApplicationManaged` auth. The session check already guards every route; the raw URL just isn't hidden. Say so in the spec. |
| Cold starts on a phone feel slow | A small bundle (standalone output) and server components. Measure in D1 and D8. |
| The VTI backfill reaches production | The same `syncBroker` path as today, tested in PGlite first. It's additive. |
