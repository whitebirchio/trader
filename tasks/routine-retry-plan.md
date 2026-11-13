# Plan: missed-run recovery

> **Status: Built** (one PR; live once Scott stores the tokens) (spec approved by Scott 2026-11-13: SPEC-agent § Missed-run recovery). One PR, then Scott sets the tokens and we run the live check.

## Why
A run that submits nothing (an outage, the usage limit, a connector failure) is emailed by `check-routine`, but recovering takes a person pressing Run now. On 2026-11-13 an Anthropic incident cost the 8:00 run; two manual re-fires failed before connectors recovered. `check-routine` should re-fire the slot's own routine itself, twice at most, and email only when that fails.

## Decisions
- **Same routine, same model:** a retry fires the missed slot's trigger (Opus at 8:00, Sonnet at 12:00).
- **+30 and +90 minutes,** only on a trading day, never after 14:45 ET, never within 30 minutes of the next slot.
- **Claim before firing:** a `routine.retry` audit event (subject `<slot ISO>#<attempt>`) is written first; its outcome is a second event, `routine.retry_result`. Both go to the digest.
- **`routine.missed` (urgent)** moves to +45 minutes after the last retry when tokens are set, or fires at once when a retry can't be made (no token, 401/403, 429, network). Without tokens, today's behaviour exactly.
- **The adapter lives in core** (`AnthropicRoutineFirer`, injected `fetch`), as `AlpacaBroker` does, so the Lambda and `routine:fire` share it.
- **One SecureString,** `/trader/production/ROUTINE_FIRE_TOKENS`, JSON `{ trigger id: token }`, optional; Scott sets it.

## Tasks
- [x] **R1. Routines in core.** `ROUTINES = [{ fireUtc, triggerId, label }]` replaces `ROUTINE_RUNS_UTC` (kept as a derived export so callers don't change). The `agent/routines.json` test checks trigger ids as well as times.
  - **Accept:** the routines.json test fails if a trigger id or a time differs.
  - Files: `src/agent/routine-watch.ts`, `test/agent/routine-watch.test.ts`.
- [x] **R2. The port and adapter.**
  - `src/agent/routine-firer.ts`: `RoutineFirer` (`fire(triggerId, text)` → `fired` with the session URL, or `failed` with HTTP status and error type); `AnthropicRoutineFirer(tokens, fetch)` posting to `/v1/claude_code/routines/{id}/fire` with `anthropic-version`, a 15 s timeout (AbortSignal), and `{ text }`. No token for a trigger → `failed` (`no_token`) without a request.
  - **Accept:** request shape; 200 → session URL; 401, 429, 500, timeout → `failed`; no result or error string contains the token.
  - Files: `src/agent/routine-firer.ts`, `test/agent/routine-firer.test.ts`, `src/index.ts`.
- [x] **R3. Retries in `checkRoutineRuns`.**
  - Optional `firer` argument. For each due slot without a submission: retry 1 at +30, 2 at +90 (window and next-slot guards), claiming with `routine.retry` before the call and recording `routine.retry_result` after. `routine.missed` at last retry + 45, or at once on a failed fire; its payload lists the attempts and the failure.
  - Without a firer: the +45 alert, unchanged.
  - **Accept:** the spec's Testing list for core; every existing test passes unchanged.
  - Files: `src/agent/routine-watch.ts`, `test/agent/routine-watch.test.ts`, `src/jobs.ts`.
- [x] **R4. Notifications.** Audit kinds `routine.retry`, `routine.retry_result` (digest), compose lines ("Research run retried at 8:30 ET (attempt 1): fired" / "…: refused (401)"); `routine.missed` text says what was tried.
  - **Accept:** routing and compose tests.
  - Files: `src/audit.ts`, `src/notifications/routing.ts`, `src/notifications/compose.ts`, tests.
- [x] **R5. Config, Lambda and infra.**
  - `ROUTINE_FIRE_TOKENS` in `ENGINE_PARAMETERS`, optional, Zod-validated (JSON object, `trig_` keys, `sk-ant-oat01-` values); a bad value names the variable, never the value.
  - `apps/lambda` builds the firer when it's set and passes it to `check-routine`.
  - `infra/test` pins the engine role's parameter ARNs.
  - **Accept:** config tests (absent, valid, invalid); handler test with a fake firer; infra test; `npm run synth`.
  - Files: `src/config.ts` (or wherever ENGINE_PARAMETERS lives), `apps/lambda/src/handler.ts`, `apps/lambda/test/handler.test.ts`, `infra/test/engine-stack.test.ts`.
- [x] **R6. `routine:fire`.** `npm run routine:fire -w @trader/core -- --env production --routine 8:00|12:00 [--dry-run]`: reads the token from SSM (`aws ssm get-parameter`, profile whitebirch), prints the request without the token on `--dry-run`, otherwise fires once and prints the session URL. Production only.
  - **Accept:** dry-run output test via the shared request builder; manual run after Scott sets the tokens.
  - Files: `scripts/routine-fire.ts`, `package.json`.
- [x] **R7. Docs.** SPEC-agent § Missed-run recovery → Built; § The routine's missed-run bullet; SPEC-notifications (the new kinds); CLAUDE.md commands (`routine:fire`); `docs/SETUP.md` (generating and storing the tokens).

## Verification
- **Gate:** `npm run typecheck && npm test`; `npm run synth`.
- No order-path change, so no paper rehearsal.
- **After merge, before tokens:** `npm run invoke -- --env production --jobs check-routine` behaves as today.
- **After Scott sets `ROUTINE_FIRE_TOKENS`:** `routine:fire --routine 8:00 --dry-run`, then one real fire on a quiet afternoon (the run submits a reaffirmed strategy, as any run would); its session shows in RemoteTrigger `list_runs`. Then the next real miss, if one comes, should retry on its own.

## Not changing
The routines' schedules, the prompt, risk, the order path.
