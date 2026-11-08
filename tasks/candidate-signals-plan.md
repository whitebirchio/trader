# Plan: candidate signals in check_eligibility (#54)

> **Status: Approved** (Scott, 2026-11-08, as the next priority after #16). Small; tasks inline.

**Why:** the routine's new rules (2026-11-08) need per-candidate arithmetic. Reporting it in `check_eligibility` makes each rule one tool call.

**Design**
- `src/agent/candidate.ts` (pure): `momentum12to1` from daily bars (decimal strings; the 252- and 21-session closes), the avoid flag at −30%, and the last earnings reaction via `research/earnings-backtest.ts` (`earningsReleases`, `reactionEvent`), with `freshEarningsCrash` at −10% within 10 sessions.
- `src/agent/sec.ts`: `SecFilings` behind a small `FilingsPort` (`latestEarningsReleases(symbol)`), with fetch injected like `AlpacaBroker`: SEC's ticker→CIK list (cached per process) and the company's submissions JSON, with SEC's "name email" User-Agent. Optional in `ToolDeps`; the MCP Lambda wires it.
- `checkEligibility`: 400 days of bars plus VTI; per symbol a `signals` block. Fail-soft on SEC errors.
- Tool description, MCP instructions and routine prompt: the rules point at these fields.

**Tasks**
- [x] C1: `candidate.ts` + tests (hand-computed 12-1, the −30% edge, the earnings reaction via fixtures, the 10-session window)
- [x] C2: `sec.ts` + tests with a fake fetch (ticker map, submissions, the 404 and failure paths)
- [x] C3: `checkEligibility` wiring + tool test (fake broker and filings); `apps/mcp` wires `SecFilings`
- [ ] C4: Prompt, instructions, SPEC-agent; gate; staging check through the staging MCP server
- [ ] Merge → production → RemoteTrigger
