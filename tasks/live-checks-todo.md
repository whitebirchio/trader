# Live checks after 2026-11-08's work

> Checks that need the calendar: a routine run or a trading session. Each links the work it verifies. When all are ticked, move this file to `tasks/done/`.

- [ ] **Mon 2026-11-09, the 8:08 AM ET routine run** (RemoteTrigger `list_runs` / `get_run_log`):
  - calls `get_track_record`, and the summary says whether the record shaped a decision (#27);
  - sets `reviewBy` on every thesis it keeps or adds (#35 and the higher bar);
  - applies the 2026-11-08 directions without selling the whole book at once;
  - sees UPBD and HGV as eligible if it considers them (#33);
  - checks candidates' 12-1 month return and skips −30%-or-worse names without a dated reason (#49);
  - calls `get_exposure` with its candidates, and sizes any `oneBet` pair as one bet (#31).
- [ ] **Mon 2026-11-09, after the close, production:** `sync-broker` records `thesis_closes`, and each thesis page's price chart draws (#39). Owner: look at a thesis page on staging or production.
- [ ] **Tue 2026-11-10, staging:** LLY (`reviewBy` 2026-11-09) unwinds on paper, and `thesis.review_overdue` is queued (suppressed on staging) (#35).
- [x] **After #48 merges:** RemoteTrigger update with the higher bar (2026-11-08); `tasks/earnings-backtest-*` moved to `tasks/done/`; stale plan paths in the research code and reports fixed.
- [x] **After the avoid-rule PR merges:** RemoteTrigger update (the momentum/quality plan's last item).
- [x] **After #61 merges:** RemoteTrigger update with `get_exposure` under "Watch concentration" (2026-11-08).
- [ ] **Fri 2026-11-13, about an hour after the close:** the first weekly letter arrives (#38); then move `tasks/weekly-letter-plan.md` to `tasks/done/`.
