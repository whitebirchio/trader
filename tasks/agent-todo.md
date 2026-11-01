# Tasks: `agent`

> Plan: [agent-plan.md](agent-plan.md) · Spec: [SPEC-agent.md](../SPEC-agent.md) · gate = typecheck + test (+ synth)

- [ ] G1: core tools: overview, strategy, holdings, activity, prices, eligibility, rules, preview (shared `runRebalance` path), submit; tests
- [ ] G2: `apps/mcp`: auth + protocol (ported from Fred), Function URL adapter, tool registry, instructions; tests including a pinned tool list
- [ ] G3: infra `trader-mcp-<env>` + IAM + assertions; `scripts/set-mcp-secrets.sh`
- [ ] G4: staging deploy; *(Scott)* connect in claude.ai; preview and submit on paper (SC-2)
- [ ] G5: `agent/routine-prompt.md`; routine run against staging (SC-3); then production triggers
- [ ] G6: production PR → merge → connect; first Claude strategy active (SC-4); SC-5 pinned
