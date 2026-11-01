# Trader

An autonomous US-equity portfolio. A scheduled Claude routine researches the market and publishes a strategy: a quant core sleeve plus a satellite sleeve of higher-conviction ideas. An AWS Lambda executes that strategy through Alpaca, but only inside guardrails that Claude can't change. The bar: beat VTI (≈ VTSAX) with real money.

- **Design:** [CAPABILITY-MAP.md](CAPABILITY-MAP.md) (modules and build order), `SPEC-*.md` (per-module specs), [docs/decisions/](docs/decisions/README.md) (why it's built this way)
- **Working on it:** [CLAUDE.md](CLAUDE.md) (commands, invariants, boundaries)
- **One-time setup:** `docs/SETUP.md`

## Quickstart

```sh
nvm use            # Node 22+
npm ci
npm run typecheck && npm test
```

Feature branches deploy to **staging** (Alpaca paper). `main` deploys to **production** (live money). Both run on AWS, defined in CDK under `infra/` (ADR-014).
