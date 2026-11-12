# Trader

An autonomous US-equity portfolio. A scheduled Claude routine researches the market (fundamentals, Congress / insider / 13F signals, news) and publishes a conviction-first strategy, with a quant-ranked systematic sleeve for the rest. An AWS Lambda executes that strategy through Alpaca, but only inside guardrails that Claude can't change. The bar: beat VTI (≈ VTSAX) with real money.

- **Design:** [CAPABILITY-MAP.md](CAPABILITY-MAP.md) (modules and build order), `SPEC-*.md` (per-module specs), [docs/decisions/](docs/decisions/README.md) (why it's built this way)
- **Working on it:** [CLAUDE.md](CLAUDE.md) (commands, invariants, boundaries)
- **One-time setup:** `docs/SETUP.md`

## Quickstart

```sh
nvm use            # Node 22+
npm ci
npm run typecheck && npm test
```

`main` deploys to **production** (live money), the only deployed environment (ADR-018). Feature branches build, test and check their migrations; order-path changes are rehearsed on the Alpaca paper account from the laptop (`--env paper`). It runs on AWS, defined in CDK under `infra/` (ADR-014).
