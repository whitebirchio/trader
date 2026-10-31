# ADR-011: Claude never gets broker order tools

## Status
Accepted

## Date
2026-10-31

## Context
Alpaca ships an official MCP server with tools like `place_stock_order`. Connecting it to the research routine would be easy.

## Decision
The engine talks to Alpaca's REST API behind `BrokerAdapter`. Claude's **only** path to a trade is `submit_strategy` → `portfolio` → `risk` → `broker`. Alpaca's MCP server may be used at development time (locally, paper keys) and never as a connector for the routine.

## Alternatives Considered

### Alpaca MCP for execution
- Rejected: it bypasses `risk` (ADR-003), and hosting it remotely puts a second internet-facing door in front of live keys.

### Alpaca MCP restricted to market-data toolsets
- Deferred: possible later as a research aid, but `agent`'s own read tools cover v1.

## Consequences
- Every order is traceable to a strategy version and a guardrail decision in the audit log.
