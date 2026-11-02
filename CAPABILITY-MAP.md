# Capability Map: Trader (v2, clean-slate)

> **Status: Approved** (Scott, 2026-10-31). Module ids are stable; each module gets `SPEC-<module-id>.md` alongside this file, specced and built in the order below.

Trader is an autonomous US-equity portfolio. **Claude owns the strategy**: it researches on a schedule and publishes a **conviction-first** strategy: research-backed theses (mostly individual stocks, up to 100% of the account), with a quant-ranked **systematic** sleeve holding the rest. Idle money sits in VTI, never cash (ADR-013). **Deterministic code owns execution and risk**: it turns the active strategy into orders, but only inside guardrails Claude cannot change. Success means beating VTI (the ETF twin of VTSAX) on the live account.

| Module id | Responsibility | Depends on |
|---|---|---|
| `foundation` | npm-workspaces monorepo, Neon + Drizzle schema base, Workers deploy + GitHub Actions CI, staging/production environments, job runner, audit-event log, config validation | — |
| `broker` | `BrokerAdapter` port + Alpaca impl; one account per environment (paper = staging, live = production); daily bars; notional/fractional orders; fill, position, equity and tax-lot sync | `foundation` |
| `risk` | Guardrail engine (pure functions): per-position and per-sleeve caps, buy eligibility (no leveraged/inverse, penny, illiquid, non-fractionable, recent IPOs), drawdown and daily-loss breakers on a flow-adjusted index, kill switch; fails closed. (The PDT rule was retired in June 2026, so there's no same-day-round-trip rule.) | `foundation` |
| `portfolio` | Versioned strategy model (Claude-authored), quant core engine driven by Claude-tuned parameters, satellite theses with expiry, sleeve targets → rebalance plan → `risk` → `broker`; wash-sale cost awareness; benchmark tracking vs VTI | `broker`, `risk` |
| `agent` | Remote MCP server (OAuth, ported from Fred) with portfolio-read, research-data, `preview_strategy` and `submit_strategy` tools (no order or control-plane tools: kill/resume stay owner-only), plus the scheduled Claude Code research routine that drives it | `portfolio` |
| `notifications` | Email for every trade and every meaningful autonomous action, driven from the audit log | `foundation` |
| `dashboard` | Read-only Next.js PWA at trader.whitebirch.io (staging: trader-staging): overview with performance vs VTI, holdings by sleeve, strategy and history, activity. Lambda Web Function behind CloudFront (OAC), Google sign-in for the owner only, SELECT-only DB role, no broker keys | `portfolio` |
| `capital` | Money in and out: a capital-flow ledger (instant-timed, feeds the risk index and a same-flows VTI comparison), owner withdrawal requests funded by a Claude-authored strategy with a deterministic fallback, the dashboard's one write path | `broker`, `risk`, `portfolio` |

**Build order:** `foundation` → `broker`, `risk`, `notifications` → `portfolio` → `agent`, `dashboard` → `capital`

**v1 milestone ("small but deployed"):** a thin vertical slice through `foundation` → `broker` → `risk` → `portfolio` (core sleeve on default quant parameters) → `agent` (`submit_strategy` + reads), deployed to staging (paper) and then promoted to production (the $1k live account), running unattended on Workers cron. `notifications` and `dashboard` follow right after.

## Cross-cutting decisions (2026-10-31)

- **Paper is a test environment, not a product.** Staging trades the Alpaca paper account and production trades the live account. They are the same code and differ only in config. Changes soak on paper before they reach real money. Nobody tracks paper performance as an outcome.
- **Email only for alerts.** No paid channels (no SMS, no ntfy).
- **Wash sales are a cost, not a rule.** `portfolio` and Claude's strategy weigh wash-sale implications when choosing trades. `risk` has no hard wash-sale block.
- **Claude never gets broker order tools.** The engine calls Alpaca's REST API behind `BrokerAdapter`; Claude's only path to a trade is `submit_strategy` → `risk`. Alpaca's own MCP server is a dev-time aid at most (paper keys, local), never a connector for the research routine.
- **Claude runs as a scheduled Claude Code routine via MCP.** There are no server-side LLM calls. If the routine stops running, the last strategy holds, and satellite theses expire back into core/cash.
