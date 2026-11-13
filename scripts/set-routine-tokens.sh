#!/usr/bin/env bash
# Store the research routines' API tokens in SSM as one SecureString,
# /trader/production/ROUTINE_FIRE_TOKENS = { "<trigger id>": "<token>" }
# (SPEC-agent § Missed-run recovery). Generate each token in the routine's
# settings on claude.ai (Trigger → + → API → Generate token); it's shown once.
# Each is pasted at a hidden prompt, so it never reaches argv, shell history,
# .env or the screen. Leave a prompt empty to leave that routine out.
#
#   scripts/set-routine-tokens.sh
set -euo pipefail
cd "$(dirname "$0")/.."

routines="$(node -e 'for (const r of require("./agent/routines.json").routines) console.log(`${r.triggerId}\t${r.name}`)')"
json="{}"
while IFS=$'\t' read -r trigger name; do
  read -r -s -p "Token for ${name} (${trigger}), or Enter to skip: " token </dev/tty
  echo
  [ -z "$token" ] && continue
  case "$token" in sk-ant-oat01-*) ;; *) echo "That doesn't look like a routine token (sk-ant-oat01-…)." >&2; exit 1 ;; esac
  json="$(TOKEN="$token" TRIGGER="$trigger" JSON="$json" node -e 'const j = JSON.parse(process.env.JSON); j[process.env.TRIGGER] = process.env.TOKEN; process.stdout.write(JSON.stringify(j))')"
done <<< "$routines"

[ "$json" = "{}" ] && { echo "No tokens entered; nothing stored."; exit 0; }
printf '%s' "$json" | scripts/put-ssm-secret.sh /trader/production/ROUTINE_FIRE_TOKENS
echo "The engine picks them up within the hour (or on its next cold start). Check with:"
echo "  npm run routine:fire -w @trader/core -- --env production --routine 8:00 --dry-run"
