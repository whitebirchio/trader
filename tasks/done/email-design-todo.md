# Todo: email design (PR 1)

- [x] layout.ts + tests (escaping, text/HTML parity, no bullet-led items, size)
  - Verify: `npx vitest run layout`
- [x] strategy-diff.ts + tests; weekly.ts uses sameExceptSummary
  - Verify: `npx vitest run strategy-diff weekly`
- [x] submitStrategy payload: previousVersion, changed, changes, cards
  - Verify: store/strategy tests
- [x] compose.ts onto the layout; strategy email; tones
  - Verify: `npx vitest run notifications`
- [x] routeEvent: reaffirmations to the digest; digest "Research runs"
  - Verify: jobs tests
- [x] routine-prompt.md summary format
- [x] notify:preview --sample/--html, notify:test --sample
  - Verify: samples rendered at 375px and 1000px
- [x] Gate: `npm run typecheck && npm test`
