#!/usr/bin/env bash
# Set one environment's Alpaca key pair as Worker secrets, read from .env
# (STAGING_ALPACA_* / PRODUCTION_ALPACA_*), without printing them.
#
#   scripts/set-alpaca-secret.sh staging|production
#
# Paper keys belong to staging and live keys to production (ADR-005). The
# Worker derives the Alpaca host from TRADING_ENV, so a key in the wrong
# environment fails to authenticate rather than reaching the other account.
set -euo pipefail
cd "$(dirname "$0")/.."

env="${1:-}"
case "$env" in
  staging) prefix=STAGING ;;
  production) prefix=PRODUCTION ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

read_env() { sed -n "s/^$1=//p" .env | sed -e "s/^[\"']//" -e "s/[\"']$//"; }

for name in ALPACA_KEY_ID ALPACA_SECRET_KEY; do
  value="$(read_env "${prefix}_${name}")"
  [ -n "$value" ] || { echo "${prefix}_${name} is not set in .env" >&2; exit 1; }
  printf '%s' "$value" | (cd apps/engine && npx wrangler secret put "$name" --env "$env")
done
