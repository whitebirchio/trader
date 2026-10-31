# Architecture decision records

Why Trader is built the way it is. Each ADR follows the `documentation-and-adrs` template. ADRs are never deleted: when a decision changes, write a new ADR that supersedes the old one. Code comments cite them as `ADR-NNN`.

| ADR | Title | Status | Date |
|---|---|---|---|
| [001](001-workers-neon-hosting.md) | Host on Cloudflare Workers + Neon Postgres | Accepted | 2026-10-31 |
| [002](002-hexagonal-core.md) | Hexagonal core with thin adapters | Accepted | 2026-10-31 |
| [003](003-claude-owns-strategy-code-owns-risk.md) | Claude owns the strategy; code owns execution and risk | Accepted | 2026-10-31 |
| [004](004-claude-via-scheduled-mcp-routine.md) | Claude runs as a scheduled routine over MCP; no server-side LLM calls | Accepted | 2026-10-31 |
| [005](005-paper-is-staging.md) | Paper trading is the staging environment; one account per environment | Accepted | 2026-10-31 |
| [006](006-branch-based-deploys.md) | Branch-based deploys: feature branches → staging, `main` → production | Accepted | 2026-10-31 |
| [007](007-idempotent-job-runs.md) | Job runs are idempotent per scheduled time | Accepted | 2026-10-31 |
| [008](008-append-only-audit-log.md) | An append-only audit log of every state-changing action | Accepted | 2026-10-31 |
| [009](009-money-as-numeric-and-big.md) | Money is `numeric` in Postgres and `Big` in code, never a JS `number` | Accepted | 2026-10-31 |
| [010](010-wash-sales-are-a-cost.md) | Wash sales are a cost the strategy weighs, not a rule | Accepted | 2026-10-31 |
| [011](011-no-broker-order-tools-for-claude.md) | Claude never gets broker order tools | Accepted | 2026-10-31 |
