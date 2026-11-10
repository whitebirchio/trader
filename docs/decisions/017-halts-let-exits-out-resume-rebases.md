# ADR-017: A drawdown halt lets closed theses out, and a resume re-bases the peak

## Status
Accepted. Supersedes ADR-012's "freeze everything" for the drawdown halt. The kill switch and owner-only resume stand.

## Date
2026-11-10

## Context
ADR-012 froze every order during a drawdown halt, sells included, because the book was about 70% broad ETFs. A 20% fall in that book was almost always market-wide, and holding through those falls has historically beaten selling. Since then, ADR-013 and ADR-016 made the book conviction-first: up to 100% in 5–8 single stocks, with idle money in VTI. The halt moved to 30%.

The multi-year insider replay ([docs/research/insider-replay-2026-11.md](../research/insider-replay-2026-11.md)) showed what the freeze now does:
- **It blocks the exits meant to limit damage.** A thesis through its stop-loss or past its review date isn't sold while halted. The baseline refused 544 orders for the halt.
- **A resume doesn't hold.** It keeps the old peak, so an account still 30% down halts again at the next sync. The replay's baseline halted on 48 sessions from June to November 2022. With 25% stops it halted on 345 sessions over 2022–2023.

## Decision
Scott, 2026-11-10:
- **Closed theses get out.** While the drawdown halt is on, portfolio still plans every step but submits only:
  - whole exits of single-stock positions whose thesis closed (stopped, stale, overdue, and later trailing-stopped), or that left the strategy (Claude removed them), tagged `purpose: "exit"`;
  - the sells an owner withdrawal needs (ADR-015).

  Risk lets an `exit` sell through only for a whole position, never part of one, and never a broad or cash-like ETF, so the tag can't turn a halt into a rebalance. Buys and resizes stay blocked, so the proceeds wait in cash until the owner resumes.
- **A resume re-bases the peak.** After a resume, the halt measures from the index at the resume, or any new high since, and trips 15% below it (`limits.reHaltPct`), until the index regains the pre-halt peak. Then the normal 30% from the all-time peak applies again.
- **Unchanged:**
  - the kill switch freezes everything;
  - only the owner resumes;
  - the halt latches;
  - the daily 8% pause blocks only buys.

## Alternatives Considered

### Keep freezing everything (ADR-012)
- Rejected: the premise, a book mostly in broad ETFs, no longer holds. Freezing exits holds falling single stocks through a crash.

### Only code-enforced exits (stops, reviews), not theses Claude removes
- Rejected (Scott, 2026-11-10): Claude re-judges every thesis every run and sells on signals. Its full exits go through too, but its resizes don't.

### Re-base the peak to the resume level at the full 30%
- Rejected: a second 30% leg from a level already 30% down is about a 50% total loss before a human is asked again.

## Consequences
- A halted account can do worse than buy-and-hold of its holdings when a sold thesis rebounds, and the cash it raised sits out the rebound until the owner resumes.
- The `exit` tag is trusted to mean "this thesis closed". Risk bounds a mistaken tag to whole single-stock positions.
- `risk_state` needs the index level at the last resume (additive), and the halt reason says which rule tripped.
