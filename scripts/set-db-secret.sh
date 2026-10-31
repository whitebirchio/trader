#!/usr/bin/env bash
# Create or rotate trader_app on one Neon branch and set that environment's
# Worker DATABASE_URL secret, without the password ever being printed.
#
#   scripts/set-db-secret.sh staging|production
#
# Reads the branch's OWNER url from .env (STAGING_MIGRATE_URL /
# PRODUCTION_MIGRATE_URL). The Worker must already exist (first CI deploy).
set -euo pipefail
cd "$(dirname "$0")/.."

env="${1:-}"
case "$env" in
  staging) var=STAGING_MIGRATE_URL ;;
  production) var=PRODUCTION_MIGRATE_URL ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

owner_url="$(sed -n "s/^${var}=//p" .env | sed -e "s/^[\"']//" -e "s/[\"']$//")"
[ -n "$owner_url" ] || { echo "$var is not set in .env" >&2; exit 1; }

password="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
app_url="$(DATABASE_URL="$owner_url" APP_ROLE_PASSWORD="$password" \
  npx -w @trader/core tsx scripts/app-role.ts --print-url)"
[ -n "$app_url" ] || { echo "app-role setup produced no URL" >&2; exit 1; }

printf '%s' "$app_url" | (cd apps/engine && npx wrangler secret put DATABASE_URL --env "$env")
