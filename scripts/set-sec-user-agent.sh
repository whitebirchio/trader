#!/usr/bin/env bash
# Store the contact SEC asks automated clients to send as their user agent
# ("Name contact@example.com") in SSM (/trader/production/SEC_USER_AGENT),
# read from .env (SEC_USER_AGENT), the same value the research scripts use.
# Both the engine (the filings check) and the MCP server (check_eligibility,
# get_exposure) read it. Without it they skip SEC and say so; a malformed one
# fails the engine's config closed, so it's checked here first.
#
#   scripts/set-sec-user-agent.sh
set -euo pipefail
cd "$(dirname "$0")/.."

value="$(sed -n "s/^SEC_USER_AGENT=//p" .env | sed -e "s/^[\"']//" -e "s/[\"']$//")"
[ -n "$value" ] || { echo "SEC_USER_AGENT is not set in .env" >&2; exit 1; }
# The same shape config.ts accepts: a name, a space, an email address.
printf '%s' "$value" | LC_ALL=C grep -Eq '^[[:print:]]{0,190}[^[:space:]@] +[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' \
  || { echo "SEC_USER_AGENT in .env isn't \"Name contact@example.com\"" >&2; exit 1; }
printf '%s' "$value" | scripts/put-ssm-secret.sh "/trader/production/SEC_USER_AGENT"
