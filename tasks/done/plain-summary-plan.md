# Plan: a plain-language summary per thesis (#60)

> **Status: Approved** (Scott, 2026-11-08: "let's proceed with #60"). Small; tasks inline. Nothing about execution changes.

## Design
- **Schema:** an optional `plainSummary` on each thesis (20–600 characters), so every stored version stays valid. `preview_strategy` returns `warnings` naming any thesis without one; it isn't a rejection.
- **Claude writes it** at submission, versioned with the thesis. The dashboard has no model access and needs none.
- **Where it shows:**
  - the dashboard: at the top of each thesis on the strategy page (`ThesisBody`), and as the thesis page's first card;
  - the activation email, under "In plain terms";
  - the weekly letter, under each thesis opened;
  - the thesis page's version history ("plain summary added / updated").
- **Routine:** a new thesis standard. Write one for every thesis, add one this run to any that lacks it, and keep it jargon-free. The prompt is a copy, so the routine needs a RemoteTrigger update after merge.
- **Resolved:** the weekly letter keeps each opened thesis's id and kind line, with the plain summary under it (the issue's open question).

## Tasks
- [x] S1: Schema, preview warnings, rules text, activation payload and email (tests)
- [x] S2: Weekly letter, dashboard (`ThesisBody`, thesis page), version-history change (tests)
- [x] S3: Routine prompt, MCP instructions and tool description, SPEC-portfolio, SPEC-agent
- [x] S4: Gate; staging deploy; merge (#63); RemoteTrigger update. The 2026-11-09 8:08 run wrote a plain summary on every thesis (v12).
