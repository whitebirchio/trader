# Spec: `dashboard`

> **Status: Draft** (2026-11-01). This is module 7 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md), and it depends on `portfolio`. It replaces the old plan for a PWA behind Cloudflare Access, which ADR-014 made moot. Decisions so far (Scott, 2026-11-01):
> - Host on Lambda **Web Functions**.
> - Sign in with **Google**.
> - Serve it at **trader.whitebirch.io**.
> - Run **both environments**.
> - Ship all four pages in v1.

## Objective

Give the owner a read-only view of Trader on his phone or laptop. It should answer, at a glance:
- How is it doing against VTI?
- What does it hold, and why?
- What is Claude's current strategy?
- What did it trade, and what did risk block?

The claude.ai connector already answers ad-hoc questions. The dashboard is the always-there view, and it's installable to the home screen as a PWA.

**Read-only throughout.** The dashboard has:
- no trading, strategy-submission or kill/resume path;
- no broker keys;
- a database role that can only `SELECT`.

The owner controls stay on the command line (ADR-012).

### Pages
| Route | Shows |
|---|---|
| `/` **Overview** | Equity, cash, today's change, drawdown from peak. Guardrail status: kill switch, halt, buys paused, broker verdict, last sync. **A performance chart**: the portfolio's flow-adjusted index (so deposits don't count as returns) against VTI, both rebased to 100 at the first snapshot, with the return figures. The active strategy version and summary. |
| `/holdings` | Positions grouped into **conviction** and **systematic**. For each: value, weight vs target, gain/loss vs average cost, and for theses the distance to the stop-loss price. Open wash-sale windows. |
| `/strategy` | Claude's summary. Each thesis with its reasoning, evidence links (kind, source, date), weight, stop-loss and state (active, stopped or stale, with days left before it goes stale). The systematic parameters. **Version history**: version, author, date and summary for each, with any version viewable. |
| `/activity` | A timeline (default 14 days, up to 90): rebalance steps with each trade's reason; orders and fills; risk clips and rejections; halts; strategy submissions and rejections. |

Staging shows a persistent **"STAGING · paper"** banner. Production shows nothing extra, matching the email convention.

## Tech stack

Same as Fred's web app, so both projects share one set of conventions:
- **Framework:** Next.js 16 (App Router, React Server Components), React 19.
- **UI:** Tailwind 4, Recharts for the chart.
- **Hosting:** **AWS Lambda Web Functions** on Node 24, Arm64. The function has a revision and a `HomeRegion` endpoint in us-east-1, defined in CDK with the L1 constructs `CfnWebFunction`, `CfnWebFunctionRevision` and `CfnWebFunctionEndpoint` (aws-cdk-lib 2.275, already installed).
- **Edge:** **CloudFront** in front, for `trader.whitebirch.io` and `trader-staging.whitebirch.io`.
  - A free ACM certificate. Scott adds its DNS-validation records and the CNAMEs in Cloudflare (DNS only).
  - Origin access control, so the raw Web Function URL can't be reached directly.
  - The `CachingDisabled` policy. All pages are dynamic and per-user.
- **Data:** `@trader/core` read functions over Neon, through the existing `@neondatabase/serverless` driver.

### Security model
1. **Sign-in:** Google OIDC, using the authorization-code flow with PKCE, `state` and `nonce`.
   - The ID token comes straight from Google's token endpoint over TLS, authenticated with the client secret.
   - The server checks its `iss`, `aud`, `exp` and `nonce`, that `email_verified` is true, and that `email` is **exactly the owner's address** (config, not code). Anyone else gets a plain 403 page.
2. **Session:** an HMAC-signed, stateless cookie, reusing the MCP's signing approach. It's `HttpOnly`, `Secure`, `SameSite=Lax`, and lasts 30 days.
   - The cookie carries the email and an expiry.
   - Rotating `DASHBOARD_SESSION_KEY` signs everyone out.
   - Every route except `/login`, `/auth/*` and the static assets checks it.
3. **The raw endpoint is closed:** CloudFront reaches the Web Function through origin access control, so its generated `*.lambda-web…on.aws` URL refuses direct callers. The session check still runs behind that.
4. **The database role is read-only:** `trader_dashboard` gets `SELECT` only, using a new `DATABASE_READ_URL` secret. Even a compromised dashboard can't write.
5. **No broker keys:** the dashboard never talks to Alpaca. VTI's daily closes, which the chart needs, are recorded by the engine.
   - **New:** an additive table, `benchmark_closes (symbol, trading_date, close)`.
   - `sync-broker` fills it in its after-close phase, and backfills one year on its first run.
6. **IAM:** the function's role can `ssm:GetParameters` on exactly three parameters: `/trader/<env>/DATABASE_READ_URL`, `GOOGLE_CLIENT_SECRET` and `DASHBOARD_SESSION_KEY`. It **cannot read the Alpaca keys**, and has no SES or SNS access. `GOOGLE_CLIENT_ID` isn't secret, so it's a plain environment variable.
7. **Headers:** a strict CSP (self plus Google's sign-in endpoints), `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, and no-store caching on every page.

### Cost
The design adds no standing cost. CloudFront and ACM fall under their always-free tiers at this volume.

Web Functions bill $0.30 per million requests, active CPU time, and **memory for as long as an execution environment exists**, including idle time until it scales to zero. AWS hasn't said whether the Lambda free tier covers them. The estimate is about $0.001 per visit, or **cents a month** for personal use.

To bound the cost, the endpoint gets `maxEnvironments: 1` and a rate limit of 100 requests per second. Issue #16's cost check covers this too. If "exactly $0" matters more than Web Functions, the fallback is a regular Lambda behind a Function URL (see Open question 4).

## Commands

```sh
npm run dev -w trader-dashboard                 # next dev on :3000 against STAGING (DATABASE_READ_URL from .env); auth bypassed only when NODE_ENV=development and DASHBOARD_DEV_EMAIL is set
npm run build -w trader-dashboard               # next build (output: standalone)
npm test -w trader-dashboard                    # vitest: auth, session, middleware, view models
npx vitest run dashboard                        # (in packages/core) the read models
npm run db:generate -w @trader/core             # after adding benchmark_closes
npm run db:dashboard-role -w @trader/core -- --env staging|production   # create/rotate trader_dashboard (SELECT-only) → SSM DATABASE_READ_URL; prints nothing secret
scripts/set-dashboard-secrets.sh staging|production   # session key (generated) + Google client secret (from .env) → SSM
npm run synth                                   # CDK: the Web Function, its endpoint, CloudFront, the cert
```

## Project structure

```
packages/core/src/dashboard/    → read models (pure over Db, no broker): overview, performance series, holdings, strategy + history, activity
packages/core/src/db/schema.ts  → + benchmark_closes (additive migration)
packages/core/src/broker/sync.ts→ after-close: record VTI's close (+ first-run backfill)
apps/dashboard/                 → Next.js app (trader-dashboard)
  app/(signed-in)/page.tsx, holdings/, strategy/, activity/   → server components calling core read models
  app/login/, app/auth/callback/ → Google OIDC
  lib/auth.ts, lib/session.ts   → OIDC + signed-cookie logic (pure, tested)
  middleware.ts                 → session check on every route
  components/                   → chart, tables, banner (client components only where needed)
  public/manifest.webmanifest, icons
infra/lib/dashboard.ts          → construct used by EngineStack: Web Function + revision + endpoint, role, CloudFront, cert
docs/SETUP.md                   → + Google OAuth client steps, DNS records
```

## Code style

Pages are server components. They call a core read model and render it, with no fetch layers or client state.

```tsx
// app/(signed-in)/holdings/page.tsx
import { holdingsView } from "@trader/core";
import { db } from "@/lib/db";
import { SleeveTable } from "@/components/sleeve-table";

export const dynamic = "force-dynamic";

export default async function HoldingsPage() {
  const view = await holdingsView(await db(), new Date());
  return (
    <>
      <SleeveTable title="Conviction" rows={view.conviction} />
      <SleeveTable title="Systematic" rows={view.systematic} />
    </>
  );
}
```

- **Money:** values stay decimal strings from core and are formatted only at render (`formatUsd("1234.5")` → `$1,234.50`). The chart is the one place that converts to numbers, for drawing only.
- **Names:** camelCase in TypeScript; components in `PascalCase.tsx`.
- **Comments:** sparse, like the rest of the repo.
- **Client code:** `"use client"` only for the chart and small toggles.

## Testing strategy

- **Core read models** (PGlite and real migrations, as in the rest of core): each view's shape on seeded data.
  - The performance series matches `compareToBenchmark`'s numbers.
  - Holdings weights add up.
  - Thesis stop distance and stale days are correct.
  - Version history is ordered.
  - VTI close recording is idempotent, and the backfill runs once.
- **Auth (vitest, apps/dashboard):**
  - The authorize URL carries PKCE, `state` and `nonce`.
  - The callback rejects a bad `state`, a bad `nonce`, a wrong `aud` or `iss`, an expired token, `email_verified: false`, and any email other than the owner's.
  - Session cookies round-trip. Tampered or expired cookies are rejected.
  - The middleware redirects to `/login` without a session.
- **Infra (CDK assertions):**
  - The Web Function role reads only those three SSM parameters, with no `ALPACA` parameter and no SES.
  - The endpoint has `maxEnvironments: 1`.
  - CloudFront uses OAC and `CachingDisabled`, and redirects to HTTPS.
  - Staging and production are identical apart from names.
- **DB role:** a script check that `trader_dashboard` can `SELECT` but `INSERT` fails.
- **Live:** sign in on staging. Each page matches `risk:status` / `strategy:show --env staging`. A second Google account gets 403. The raw endpoint URL is refused.

## Boundaries

- **Always:**
  - The dashboard is read-only.
  - Check the session on every route.
  - Keep logic in core read models.
  - Show money as decimal strings until render.
  - Show the staging banner on staging.
- **Ask first:**
  - Any write or control action in the UI.
  - Giving the dashboard broker keys or a write role.
  - Allowing a second email.
  - Adding caching of signed-in pages.
  - Paid AWS features (WAF, provisioned anything).
- **Never:**
  - An order, strategy or kill/resume path.
  - Exposing secrets, full account numbers or tokens in pages.
  - Letting the dashboard's role read another environment's or the Alpaca SSM parameters.
  - Disabling the session check outside local development.

## Success criteria

1. Gate green: core read models, auth, middleware and infra assertions pass, and `next build` succeeds.
2. **Staging:**
   - `https://trader-staging.whitebirch.io` sends you to Google. After you sign in as the owner, the overview loads in under 2 seconds warm (a cold start is allowed to take longer).
   - A different Google account gets 403.
   - The raw Web Function URL is refused.
3. Each page matches the staging data. Equity and guardrails match `risk:status`; the strategy and theses match `strategy:show`; activity matches the audit log. The chart draws from the first snapshot onward, with VTI on the same dates.
4. `trader_dashboard` can't write: an `INSERT` attempt fails. Infra tests show no Alpaca or SES access.
5. **Production:** `https://trader.whitebirch.io` is live behind the same sign-in.
6. It installs to the iPhone home screen and opens full-screen with an icon.
7. No new standing-cost resources (checked with the #16 cost review).

## Open questions

1. **The Google OAuth client:** you create one in the Google Cloud Console (a Web application client). Its authorized redirect URIs are `https://trader.whitebirch.io/auth/callback` and `https://trader-staging.whitebirch.io/auth/callback`. Put its id and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. One client for both environments is fine. OK? I'll write step-by-step instructions in SETUP.md.
2. **DNS in Cloudflare:** you add the ACM validation CNAMEs (printed as stack outputs, like the DKIM records were), plus `trader` and `trader-staging` CNAMEs pointing at their CloudFront domains, set to DNS only. OK?
3. **The `benchmark_closes` table and the after-close VTI recording:** a small additive change to the engine, which merges to production like any migration. OK?
4. **Web Functions unknowns, resolved by a spike before anything else is built:**
   - how a revision starts a Next.js standalone server: the start command, and the port it gets via `AWS_LAMBDA_HTTP_ENDPOINT`;
   - whether CloudFront OAC works with a Web Function endpoint from CloudFormation;
   - whether the free tier applies.

   **Fallback** if the spike fails: a regular Lambda running Next.js through the Lambda Web Adapter, behind a Function URL with OAC. That's known to work and is free-tier, and the rest of this spec is unchanged.
