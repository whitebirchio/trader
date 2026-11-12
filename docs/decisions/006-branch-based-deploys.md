# ADR-006: Branch-based deploys: feature branches → staging, `main` → production

## Status
Superseded by [ADR-018](018-production-is-the-only-deployed-environment.md) (2026-11-11).

## Date
2026-10-31

## Context
Following ADR-005, changes should run on paper before real money, without a manual promotion ceremony. The repo is private on a GitHub Free org, where GitHub Environments (used by Corpus's deploy gate) aren't available.

## Decision
CI builds every push and PR. A **push to any branch other than `main`** migrates the Neon `staging` branch and deploys `--env staging`. A **push or merge to `main`** migrates `production` and deploys `--env production`. Migrations run in CI before the Worker deploys. Secrets are repo-level.

## Alternatives Considered

### Manual promotion job for production
- Rejected by Scott in favour of automatic deploys from `main`.

### Corpus-style `environment: production`
- Rejected: on the Free plan it would force the repo public.

## Consequences
- Merging means shipping to real money, so migrations must be additive (expand → contract) and destructive ones are ask-first.
- Staging holds whichever branch was pushed last. That's fine with one developer.
- An abandoned branch's migration can leave staging ahead of production. Fix it by resetting the Neon `staging` branch from its parent.
