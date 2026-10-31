# ADR-004: Claude runs as a scheduled routine over MCP; no server-side LLM calls

## Status
Accepted

## Date
2026-10-31

## Context
Claude needs to research (web search, reading filings and news) and publish strategy updates without Scott in the conversation. It could do that either through server-side Anthropic API calls from a Worker cron, or as an agent connecting to Trader's own MCP server (the Corpus pattern, Corpus ADR-021).

## Decision
Trader exposes a remote MCP server (`agent` module). A **scheduled Claude Code routine** connects to it, researches with its own tools, and calls tools such as `submit_strategy`. The engine makes **no LLM calls**.

## Alternatives Considered

### Server-side Messages API from a Worker cron
- Rejected for v1: per-token cost, and it duplicates research capability the agent already has. It could be added later on top of the same core functions.

## Consequences
- No API bill; inference rides the Claude subscription.
- The routine is not guaranteed to run. If it doesn't, the last strategy keeps executing and satellite theses expire back into core/cash, so a missed run fails safe.
- Whether a routine can reliably reach a custom OAuth MCP connector is the main risk to this decision. The `agent` module proves it with a spike before building the rest.
