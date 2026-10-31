# ADR-002: Hexagonal core with thin adapters

## Status
Accepted

## Date
2026-10-31

## Context
The logic that decides money movements must be testable without a network, a broker or a Worker runtime. Corpus solved the same problem with a core package that has no HTTP or MCP dependencies (Corpus ADR-004).

## Decision
All domain logic lives in `@trader/core` (`packages/core`): schema, config, money, jobs, and later guardrails, strategy and rebalancing. Apps (`apps/engine`, later `apps/mcp-server` and `apps/web`) are thin shells: validate → call core → respond. External services (Alpaca, email) sit behind **ports defined in core**, with HTTP implementations injected by the app.

## Alternatives Considered

### Logic inside the Worker handlers
- Rejected: untestable without the Workers runtime, and duplicated once a second app (MCP, dashboard) needs the same logic.

## Consequences
- Tests run against PGlite and fake ports, which is fast, offline and deterministic.
- Adding a surface (MCP tool, dashboard route) adds no business logic, so surfaces can't disagree with each other.
