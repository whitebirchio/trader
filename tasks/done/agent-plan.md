# Implementation Plan: `agent`

> Implements [SPEC-agent.md](../../SPEC-agent.md) (approved 2026-11-01). Tasks are in [agent-todo.md](agent-todo.md). Kept short on purpose: the deadline is Monday's 9:45 ET step.

## Order
1. **G1, core tools** (`packages/core/src/agent/`): pure functions over `Db` + `BrokerAdapter`, PGlite-tested. `preview` reuses `runRebalance` with `dryRun` plus a candidate strategy override.
2. **G2, MCP app** (`apps/mcp`): Fred's stateless auth and protocol, ported (Web `Request`/`Response`), plus a Function URL adapter, the tool registry and the instructions.
3. **G3, infra**: the `trader-mcp-<env>` function, URL and IAM in `EngineStack`; `scripts/set-mcp-secrets.sh`.
4. **G4, staging live**: deploy, you connect in claude.ai, preview and submit on paper.
5. **G5, the routine**: the prompt in `agent/routine-prompt.md`; one run against staging; then production, 8:00 and 12:00 ET.
6. **G6, production**: PR → merge → connect → the routine targets production.

## Key decisions
- **`preview_strategy` and the rebalance job share one code path.** `runRebalance` gains `strategyOverride`, so a preview is exactly what the next step would do.
- **The MCP Lambda shares the engine's SSM path** and adds `MCP_*` parameters. It has no SES permission and no schedule.
- **Tool output is JSON with readable fields.** Money stays as decimal strings.
- **The tool list is pinned by a test,** so an order-capable tool can't be added silently (SPEC SC-5).

## Risks
| Risk | Mitigation |
|---|---|
| Routines can't attach a custom OAuth connector | Verified first, in G5 against staging. Fallback: a static-bearer connector, or a routine via the Claude Code CLI. If neither works, version 0 keeps trading. |
| Deadline | G1–G4 first, so you can already chat with and submit through staging tonight. Production follows. Version 0 trades tomorrow regardless. |
