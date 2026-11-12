#!/usr/bin/env bash
# Create or rotate trader_readonly (SELECT only) on production's Neon branch
# and store its URL in SSM as /trader/production/READONLY_DATABASE_URL, never
# printing it (ADR-018). The read-only status scripts read it from there.
#
#   scripts/set-readonly-secret.sh
#
# Uses PRODUCTION_MIGRATE_URL (the owner role) from .env.
set -euo pipefail
cd "$(dirname "$0")/.."

read_env() { sed -n "s/^$1=//p" .env | sed -e "s/^[\"']//" -e "s/[\"']$//"; }
random() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

owner_url="$(read_env PRODUCTION_MIGRATE_URL)"
[ -n "$owner_url" ] || { echo "PRODUCTION_MIGRATE_URL is not set in .env" >&2; exit 1; }
url="$(DATABASE_URL="$owner_url" READONLY_ROLE_PASSWORD="$(random 32)" \
  npx -w @trader/core tsx scripts/readonly-role.ts --print-url)"
[ -n "$url" ] || { echo "readonly-role setup produced no URL" >&2; exit 1; }
printf '%s' "$url" | scripts/put-ssm-secret.sh "/trader/production/READONLY_DATABASE_URL"
