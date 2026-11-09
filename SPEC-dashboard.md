# Spec: `dashboard`

> **Status: Built** (approved and shipped 2026-11-01: #17). Live at https://trader.whitebirch.io and https://trader-staging.whitebirch.io. SC-1 to SC-5 verified; SC-6 (home-screen install) is for Scott to try; SC-7 is covered by the cost check (#16). This is module 7 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md), and it depends on `portfolio`. It replaces the old plan for a PWA behind Cloudflare Access, which ADR-014 made moot. Decisions so far (Scott, 2026-11-01):
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

> **Amendment 1 (Scott, 2026-11-02; SPEC-capital, ADR-015): one write.** The **Money** page (`/money`) can queue withdrawal commands: *Withdraw*, *Fund now* and *Cancel*. That is the dashboard's only write, and it can't move money out of the account (the ACH is done in Alpaca, to the linked bank).
> - **Database:** `trader_dashboard` gains `INSERT` on `capital_commands` alone (migration `0016`). It keeps `default_transaction_read_only`, so the write runs as an explicit read-write transaction (`src/lib/write.ts`). It has no `UPDATE` or `DELETE` anywhere, and the table's trigger rejects them for every role. `db:dashboard-role -- --check` proves this without rotating the password.
> - **Request checks** (`src/lib/commands.ts`, all tested): an owner session; an `Origin` header that equals `DASHBOARD_URL` (missing fails closed); a signed form token bound to the owner's email, valid 30 minutes; and an explicit confirmation field. The Money page's buttons only GET `/money/confirm`, which repeats exactly what will be sent; only its POST form writes.
> - **Engine side:** the engine validates and applies each command on its next tick and emails the owner about every command, accepted or rejected.
> - **Blast radius** if the dashboard were compromised: forced sells and cash held idle. The trading, strategy and kill/resume paths are still absent, and there are still no broker keys or SES access.

### Pages
| Route | Shows |
|---|---|
| `/` **Overview** | Equity, cash, today's change, drawdown from peak. Guardrail status: kill switch, halt, buys paused, broker verdict, last sync. **A performance chart**: the portfolio's flow-adjusted index (so deposits don't count as returns) against VTI, both rebased to 100 at the start of the chosen range (#59: 4 weeks, 3 months, 6 months, YTD, 1 year or since start; default since start), with the range's return figures. The active strategy version and summary. |
| `/holdings` | Positions grouped into **conviction** and **systematic**. For each: value, weight vs target, gain/loss vs average cost, and for theses the distance to the stop-loss price. Open wash-sale windows. |
| `/strategy` | Claude's summary. Each thesis with its reasoning, evidence links (kind, source, date), weight, stop-loss and state (active, stopped or stale, with days left before it goes stale). The systematic parameters. **Version history**: version, author, date and summary for each, with any version viewable. |
| `/track-record` | The thesis scorecard (SPEC-portfolio § Scorecard, 2026-11-07): each thesis ever held with its return on the dollars bought, the same dollars in VTI, and the gap; how it ended and days held; totals overall and by primary evidence kind. The same data Claude reads through `get_track_record`. Each symbol links to its thesis page. |
| **Ranges (#59)** | Both time-series charts have a range picker in one row above the chart. Each range is a link (`?range=4w`, so it can be bookmarked; a bad value falls back to the default). A range's base is the last data point on or before its start date. A range the history doesn't reach yet is shown disabled with the date the history starts, and asking for it falls back to the default. The table view follows the range. |
| `/theses/[id]` | One thesis (#39, `tasks/thesis-page-plan.md`), found by any id in its chain: its track-record figures (or "not bought yet"); a price chart of daily closes over the chosen range (#59: 4 weeks, 3 months, 6 months, 1 year, or since first held, the default), with the average cost, the stop while held, fills as ▲/▼ markers and evidence dates as guides; its reasoning and evidence from the latest version that lists it; its version history (weight, stop, review date and what changed, including the version that dropped it); and its automatic exits. Linked from the track record, the strategy page and holdings. |
| `/activity` | A timeline (default 14 days, up to 90): rebalance steps with each trade's reason; orders and fills; risk clips and rejections; halts; strategy submissions and rejections. |

Staging shows a persistent **"STAGING · paper"** banner. Production shows nothing extra, matching the email convention.

### Amendment 2 (2026-11-08): phones

> **Status: Approved** (Scott, 2026-11-08, with the menu and sign-out answers below). Scott, 2026-11-08: "On mobile (using the PWA) in particular, I'm noticing some bad UX." Every page is used on the phone; the most used are Overview, Holdings, Track record and Activity, then Strategy. Device: iPhone 15 (393 × 852 CSS px), iOS 27, installed to the home screen from Chrome. That install runs on WebKit like a Safari install, so the iOS home-screen rules apply.

**What's wrong today:**
- **The page scrolls sideways.** The top menu (six links plus "Sign out" on one row that can't wrap) is about 500 px wide on a 393 px screen.
- **Tables are wide:** Holdings, Track record (by kind and theses), Activity, Money and the thesis version history have fixed minimum widths of 384–704 px, so each scrolls sideways inside its card.
- **Charts are cramped.** The thesis chart keeps about 100 px for its right-hand labels, leaving about 200 px of plot, and full ISO dates crowd the x-axis.
- **Tap targets are small:** about 24 px for the range picker, "Sign out" and "Table view".
- **Home-screen gaps:** no reload or pull-to-refresh exists in a home-screen app, so data goes stale; nothing pads for the home indicator; the status bar style doesn't match the dark theme; and a text field under 16 px makes iOS zoom in on focus.

**Objective:** every page works one-handed on an iPhone 15 without sideways scrolling, and quick answers come first: how it's doing vs VTI, what's held, what changed. The laptop layout stays as it is.

**Decisions:**
- **One site that adapts to the screen** (Tailwind breakpoints), not a separate mobile app. Phone layouts apply below 640 px (`sm`). At 640 px and up, the layout is as today.
- **The menu stays at the top.** On phones it's one row (about 44 px tall) that scrolls sideways inside itself, never the page. It's built so the extra items are obvious and easy to reach:
  - the next item is visibly cut off at the edge, and that edge fades out;
  - the current page is scrolled into view on load;
  - it's ordinary swipe scrolling (`overflow-x: auto` with momentum), with no hidden gestures.
  
  On every screen size, the current page is highlighted (`aria-current`); today nothing marks it.
- **Sign out stays available but out of the way.** On phones, it's a small link at the foot of every page, below the content. On wider screens, it stays in the header as today.
- **Tables become cards on phones.** Each row becomes a compact card leading with the figures that matter. Holdings: symbol, value, weight vs target, gain, distance to stop. Track record: symbol, how it ended, return vs VTI. Activity: time, what happened, symbol and amount. Detail is a tap away: thesis cards open the thesis page (#39), and other cards expand in place. Tables stay as they are on wider screens.
- **Charts fit:** shorter date labels on phones ("Nov 2"), fewer ticks, direct labels that fit inside the plot, and a tap that shows the tooltip. Range pickers wrap, with tap targets of at least 44 px.
- **Home-screen fixes:**
  - padding for the safe areas at the top and bottom;
  - the status bar: kept as `default`, with the per-scheme theme colours. `black-translucent` draws white status-bar text, which the light theme would hide, so it changes only if Scott's phone shows a problem;
  - text inputs at 16 px or more;
  - a refresh control in the header;
  - an automatic refresh (`router.refresh()`) when the app comes back to the foreground more than a minute after its last load.
- **No change to data or behaviour.** Read models, the one write (Amendment 1's withdrawal commands, with every check), auth and headers stay as they are. Presentation only.
- **New dev dependency:** **Playwright**, to drive the iPhone 15 device profile in a headless browser. It's local and on demand only, so CI time doesn't change.

**Commands:**
```sh
npm run mobile:check -w trader-dashboard   # Playwright, iPhone 15 profile: every page against local next dev (staging read data, dev sign-in bypass); fails on sideways scroll or a tap target under 44 px; writes screenshots to apps/dashboard/.mobile/ (git-ignored)
```

**Testing:**
- **Automated (`mobile:check`, on demand before each PR):** on every signed-in page (`/`, `/holdings`, `/money`, `/money/confirm` for a cancel and a request (a GET only renders it), `/strategy`, `/strategy/[version]`, `/track-record`, `/activity`, `/theses/[id]` with each range) and on `/login`, at 393 × 852:
  - `document.documentElement.scrollWidth` is at most the viewport width;
  - the menu, range pickers, refresh control and card toggles are at least 44 × 44 px;
  - no text input renders under 16 px.
  
  It also runs at 1280 px, to show the desktop is unchanged.
- **Unit (vitest, apps/dashboard):** the short date formatter, and the card/table split of each converted table (where a component has logic).
- **Live:** Scott checks staging on his iPhone from the home screen: no sideways scroll on any page, the menu works one-handed, cards read well, charts are legible, the refresh works, and nothing hides under the notch or home indicator.

**Boundaries:**
- **Always:** keep laptop layouts as they are (apart from the current-page highlight); keep logic in core read models; run `mobile:check` before opening each PR.
- **Ask first:** dropping a column's data from the phone layout entirely (rather than moving it behind a tap); changing a read model's shape for layout's sake; anything touching the Money page's command flow beyond styling.
- **Never:** a new write path; caching signed-in pages; weakening the CSP or frame-ancestors to make testing easier (`mobile:check` runs against local dev instead).

**Success criteria (Amendment 2):**
1. At 393 × 852, no page scrolls sideways, and `mobile:check` passes on every page listed above.
2. On a phone, the menu never scrolls the page. Every page is reachable by swiping the menu row and tapping. The cut-off next item and the faded edge show there's more, the current page is marked and in view, and "Sign out" is at the foot of every page.
3. On a phone, Holdings, Track record, Activity, Money and the thesis version history show cards, not wide tables, with every figure either shown or one tap away.
4. Charts at 393 px have at least 280 px of plot, readable date labels, and tap-to-inspect.
5. From the home screen: content clears the Dynamic Island and the home indicator; tapping the withdrawal amount doesn't zoom; the refresh control and the refresh on returning to the app both reload data.
6. At 1280 px, every page looks as it does today, apart from the current-page highlight (checked against `mobile:check`'s desktop screenshots).
7. Scott confirms on his iPhone, on staging, before merge.

**Resolved (Scott, 2026-11-08):**
1. **Menu:** one row that scrolls inside itself is fine, provided it's obvious there's more and it's easy to reach (the cut-off item, the faded edge, the current page in view).
2. **Sign out:** keep it available somewhere unobtrusive. It goes at the foot of each page on phones.

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
4. **The database role is read-only,** apart from Amendment 1's one INSERT: `trader_dashboard` gets `SELECT`, plus `INSERT` on `capital_commands`, using a new `DATABASE_READ_URL` secret. Even a compromised dashboard can't change anything else.
5. **No broker keys:** the dashboard never talks to Alpaca. VTI's daily closes, which the chart needs, are recorded by the engine.
   - **New:** an additive table, `benchmark_closes (symbol, trading_date, close)`.
   - `sync-broker` fills it in its after-close phase, and backfills one year on its first run.
   - **#39:** `thesis_closes (symbol, trading_date, close)` holds the adjusted closes of every symbol any strategy version has held as a thesis, from 380 days before its first version (so the 1-year range works from the start; #59). It is recorded the same way, best effort, in one bars request.
6. **IAM:** the function's role can `ssm:GetParameters` on exactly three parameters: `/trader/<env>/DATABASE_READ_URL`, `GOOGLE_CLIENT_SECRET` and `DASHBOARD_SESSION_KEY`. It **cannot read the Alpaca keys**, and has no SES or SNS access. `GOOGLE_CLIENT_ID` isn't secret, so it's a plain environment variable.
7. **Headers:** a strict CSP (self plus Google's sign-in endpoints), `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, and no-store caching on every page.

### Cost
The design adds no standing cost. CloudFront and ACM fall under their always-free tiers at this volume.

Web Functions bill $0.30 per million requests, active CPU time, and **memory for as long as an execution environment exists**, including idle time until it scales to zero. AWS hasn't said whether the Lambda free tier covers them. The estimate is about $0.001 per visit, or **cents a month** for personal use.

To bound the cost, the endpoint gets `maxEnvironments: 2` (the minimum, per the D1 spike) and a rate limit of 100 requests per second. Issue #16's cost check covers this too. If "exactly $0" matters more than Web Functions, the fallback is a regular Lambda behind a Function URL (see Open question 4).

## Commands

```sh
npm run dev -w trader-dashboard                 # next dev on :3000 against STAGING (DATABASE_READ_URL from .env); auth bypassed only when NODE_ENV=development and DASHBOARD_DEV_EMAIL is set
npm run build -w trader-dashboard               # next build (output: standalone)
npm test -w trader-dashboard                    # vitest: auth, session, middleware, view models
npx vitest run dashboard                        # (in packages/core) the read models
npm run db:generate -w @trader/core             # after adding benchmark_closes
scripts/set-dashboard-secrets.sh staging|production   # trader_dashboard (SELECT-only, read-only transactions; rotates) → DATABASE_READ_URL, session key (generated into .env), Google client secret (from .env) → SSM; prints names only
npm run db:dashboard-role -w @trader/core          # the role step alone (DATABASE_URL=owner, DASHBOARD_ROLE_PASSWORD); proves INSERT/UPDATE/DELETE/CREATE are denied
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
  - The endpoint has `maxEnvironments: 2` and `IamAuth`, and the resource policy allows only this distribution.
  - CloudFront uses OAC and `CachingDisabled`, and redirects to HTTPS.
  - Staging and production are identical apart from names.
- **DB role:** a script check that `trader_dashboard` can `SELECT` but `INSERT` fails.
- **Live:** sign in on staging. Each page matches `risk:status` / `strategy:show --env staging`. A second Google account gets 403. The raw endpoint URL is refused.

## Boundaries

- **Always:**
  - The dashboard is read-only, except for queueing withdrawal commands (Amendment 1).
  - Check the session on every route.
  - Keep logic in core read models.
  - Show money as decimal strings until render.
  - Show the staging banner on staging.
- **Ask first:**
  - Any write or control action in the UI beyond Amendment 1's withdrawal commands.
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

## D1 spike findings (2026-11-01)

A throwaway stack, since destroyed, ran Next.js 16 standalone on a Web Function behind CloudFront. **Decision: Web Functions.** The fallback isn't needed.

| Question | Finding |
|---|---|
| Start contract | The runtime loads `index.js` from the package root. Our `index.js` copies `AWS_LAMBDA_HTTP_ENDPOINT` (host:port) into `HOSTNAME`/`PORT`, then `import("./server.js")` (Next's ESM standalone server). The package is `.next/standalone` plus `.next/static`, zipped (about 37 MB unzipped for a minimal app). The runtime is `nodejs24.x` (Node 24.22). |
| Locking down the raw URL | Works. The endpoint uses `AuthType: IamAuth`. CloudFront uses an OAC with origin type `lambda` and signing `always-amz-auth`, and an `AWS::Lambda::ResourcePolicy` lets `cloudfront.amazonaws.com` call `lambda:InvokeWebFunctionEndpoint`, but only from this distribution (`aws:SourceArn`). Direct calls get **403**. |
| Through CloudFront | GET, **POST (no payload-hash header needed)**, `Set-Cookie`, cookies, static assets and the `Authorization` header all pass through. The `CachingDisabled` and `AllViewerExceptHostHeader` policies are in place. |
| `+` in query strings | **Found in D8:** a literal `+` in the query string fails the OAC signature check at the endpoint (403 "You are not authorized to access this endpoint", before the app). Google's callback always sends `scope=email+openid+…`. A CloudFront Function (viewer-request) re-encodes `+` as `%20` (the same space). The spike missed it because none of its URLs had a `+`. |
| Host | The app sees the endpoint's domain as `Host`, not the viewer's domain. **Every absolute URL** (OIDC redirect URI, redirects) **comes from config (`DASHBOARD_URL`)**, never from `req.url`. Use relative redirects. |
| Latency | Cold start 1.4 s; warm about 0.2 s, from the laptop through CloudFront. |
| Scaling | `ScalingConfig.MaxEnvironments` must be **≥ 2**. |
| Code | Code comes only from S3: **our own versioned bucket**, whose policy lets `lambda.amazonaws.com` read objects for `web-function/<name>/revision/*`. A `BucketDeployment` uploads it (`extract: false`). Deleting an object version that a revision uses fails that revision permanently, so expire **noncurrent** versions after 30 days and never delete current ones. |
| Logs | Logs go to `/aws/lambda/web/<name>.local`, which is auto-created with no retention. The stack creates both that group and `/aws/lambda/web/<name>` with 30-day retention. |
| Gotchas | npm now installs TypeScript 7 (the native port), which Next 16 can't load, so pin `typescript@6.0.3` (as the repo does). The CloudFormation validator warns F3006 "unknown resource type" for the Web Function types; that's a known issue and harmless. |
| Cert | An ACM certificate with DNS validation blocks its stack until Scott adds the records. So the certificate gets **its own small stack (`TraderCerts`)**, deployed and validated once before the dashboard is wired to the domains. |
| Free tier | Still unconfirmed. Watch the bill (#16). |

## Open questions

1. **The Google OAuth client:** you create one in the Google Cloud Console (a Web application client). Its authorized redirect URIs are `https://trader.whitebirch.io/auth/callback` and `https://trader-staging.whitebirch.io/auth/callback`. Put its id and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. One client for both environments is fine. OK? I'll write step-by-step instructions in SETUP.md.
2. **DNS in Cloudflare:** you add the ACM validation CNAMEs (printed as stack outputs, like the DKIM records were), plus `trader` and `trader-staging` CNAMEs pointing at their CloudFront domains, set to DNS only. OK?
3. **The `benchmark_closes` table and the after-close VTI recording:** a small additive change to the engine, which merges to production like any migration. OK?
4. ~~**Web Functions unknowns**~~ Resolved by the D1 spike (above): Web Functions it is. Original question:
   - how a revision starts a Next.js standalone server: the start command, and the port it gets via `AWS_LAMBDA_HTTP_ENDPOINT`;
   - whether CloudFront OAC works with a Web Function endpoint from CloudFormation;
   - whether the free tier applies.

   **Fallback** if the spike fails: a regular Lambda running Next.js through the Lambda Web Adapter, behind a Function URL with OAC. That's known to work and is free-tier, and the rest of this spec is unchanged.
