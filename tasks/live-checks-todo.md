# Live checks after 2026-11-08's work

> Checks that need the calendar: a routine run or a trading session. Each links the work it verifies. When all are ticked, move this file to `tasks/done/`.

- [x] **Mon 2026-11-09, the 8:08 AM ET routine run** (session `cse_01S4rxYqXEJeMPB84sKm5nWa`; submitted v12, reaffirming all seven theses with no trades):
  - [x] calls `get_track_record`; the summary names TTMI as the weakest thesis against VTI (#27);
  - [x] sets `reviewBy` on every thesis: 2027-01-29 to 2027-02-04, about three months after each first buy (#35 and the higher bar);
  - [x] applies the 2026-11-08 directions without selling the whole book at once: insider-led theses are kept and will be replaced as they come up for review;
  - [x] UPBD and HGV: not considered this run (#33);
  - [x] checks a candidate's 12-1 month return (CWST −6.6%) and its earnings timing (#49, #54);
  - [x] calls `get_exposure` and flags industrials at about 31%. It ran without its candidates, though the prompt asks for them; watch for that when it next adds a name (#31);
  - [x] writes a `plainSummary` on every thesis: the preview came back with no warnings (#60);
  - [x] every tool worked on the least-privilege MCP credentials, including the first production `get_exposure` and `submit_strategy` (review R1, #73).
  - Found: `get_activity` (7 days) returned about 72k characters, over the routine's tool-output limit (#74).
- [ ] **Mon 2026-11-09, after the close, production:** `sync-broker` records `thesis_closes`, and each thesis page's price chart draws (#39). Owner: look at a thesis page on staging or production.
- [ ] **Tue 2026-11-10, staging:** LLY (`reviewBy` 2026-11-09) unwinds on paper, and `thesis.review_overdue` is queued (suppressed on staging) (#35).
- [x] **After #48 merges:** RemoteTrigger update with the higher bar (2026-11-08); `tasks/earnings-backtest-*` moved to `tasks/done/`; stale plan paths in the research code and reports fixed.
- [x] **After the avoid-rule PR merges:** RemoteTrigger update (the momentum/quality plan's last item).
- [x] **After #61 merges:** RemoteTrigger update with `get_exposure` under "Watch concentration" (2026-11-08).
- [ ] **Fri 2026-11-13, about an hour after the close:** the first weekly letter arrives (#38); then move `tasks/weekly-letter-plan.md` to `tasks/done/`.
