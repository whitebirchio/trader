#!/usr/bin/env bash
# Store the Alpha Vantage key for the earnings calendar (#30) in SSM
# (/trader/<env>/ALPHAVANTAGE_API_KEY), read from .env (ALPHAVANTAGE_API_KEY),
# never printed. One free key serves both environments: the engine spends one
# request a day per environment, of the free tier's 25.
#
#   scripts/set-alphavantage-secret.sh staging|production
set -euo pipefail
cd "$(dirname "$0")/.."

env="${1:-}"
case "$env" in
  staging | production) ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

value="$(sed -n "s/^ALPHAVANTAGE_API_KEY=//p" .env | sed -e "s/^[\"']//" -e "s/[\"']$//")"
[ -n "$value" ] || { echo "ALPHAVANTAGE_API_KEY is not set in .env" >&2; exit 1; }
printf '%s' "$value" | scripts/put-ssm-secret.sh "/trader/$env/ALPHAVANTAGE_API_KEY"
