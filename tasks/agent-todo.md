# Tasks: `agent`

> Plan: [agent-plan.md](agent-plan.md) · Spec: [SPEC-agent.md](../SPEC-agent.md) · gate = typecheck + test (+ synth)

- [x] G1: core tools: overview, strategy, holdings, activity, prices, eligibility, rules, preview (shared `runRebalance` path), submit; tests
- [x] G2: `apps/mcp`: auth + protocol (ported from Fred), Function URL adapter, tool registry, instructions; tests including a pinned tool list
- [x] G3: infra `trader-mcp-<env>` + IAM + assertions; `scripts/set-mcp-secrets.sh`
- [x] G4: staging deploy; *(Scott)* connect in claude.ai; preview and submit on paper (SC-2)
- [x] G5: `agent/routine-prompt.md`; routine run against staging (SC-3: v1 activated by the routine over OAuth, 2026-11-01); routine `trig_019uVfvbsEyzRfobyggy8kzy` enabled, weekdays 8:00 + 12:00 ET, staging until G6
- [x] G6: production PR (#10) → merge → connect; routine switched to `Trader_production` (2026-11-01); first Claude strategy expected Mon 2026-11-02 8:05 ET, before the 9:45 step (SC-4); SC-5 pinned by `apps/mcp/test/server.test.ts`
