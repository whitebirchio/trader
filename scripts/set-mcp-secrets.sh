#!/usr/bin/env bash
# Store one environment's MCP secrets in SSM (/trader/<env>/MCP_*), never
# printing them (SPEC-agent).
#
#   scripts/set-mcp-secrets.sh staging|production [--rotate]
#
# Values live in .env as <ENV>_MCP_SIGNING_KEY, <ENV>_MCP_PASSPHRASE and
# <ENV>_MCP_TOKEN. Any that are missing are generated and added there, so .env
# is where you read the passphrase (for the consent page) and the static
# token (for curl or Claude Code). To choose your own passphrase, put it in
# .env before running (16+ characters). --rotate regenerates the signing key
# and token, which revokes every connector's access; reconnect afterwards.
# The MCP Lambda re-reads SSM within 15 minutes, so no deploy is needed.
set -euo pipefail
cd "$(dirname "$0")/.."

env="${1:-}"
case "$env" in
  staging) prefix=STAGING ;;
  production) prefix=PRODUCTION ;;
  *) echo "usage: $0 staging|production [--rotate]" >&2; exit 2 ;;
esac
rotate="${2:-}"

touch .env
chmod 600 .env

read_env() { sed -n "s/^$1=//p" .env | sed -e "s/^[\"']//" -e "s/[\"']$//"; }
random() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
# Replace or append NAME=value in .env without the value touching argv.
write_env() {
  NAME="$1" node -e '
    const fs = require("fs");
    let v = ""; process.stdin.on("data", (d) => (v += d)).on("end", () => {
      const name = process.env.NAME;
      const lines = fs.readFileSync(".env", "utf8").split("\n").filter((l) => !l.startsWith(name + "="));
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${name}=${v}`, "");
      fs.writeFileSync(".env", lines.join("\n"), { mode: 0o600 });
    });'
}

for name in MCP_SIGNING_KEY MCP_TOKEN MCP_PASSPHRASE; do
  var="${prefix}_${name}"
  value="$(read_env "$var")"
  if [ -z "$value" ] || { [ "$rotate" = "--rotate" ] && [ "$name" != MCP_PASSPHRASE ]; }; then
    case "$name" in
      MCP_PASSPHRASE) p="$(random 24)"; value="${p:0:6}-${p:6:6}-${p:12:6}-${p:18:6}" ;;
      *) value="$(random 48)" ;;
    esac
    printf '%s' "$value" | write_env "$var"
    echo "  generated $var in .env"
  fi
  min=32; [ "$name" = MCP_PASSPHRASE ] && min=16
  [ "${#value}" -ge "$min" ] || { echo "$var must be at least $min characters" >&2; exit 1; }
  printf '%s' "$value" | scripts/put-ssm-secret.sh "/trader/$env/$name"
done
echo "Done. The passphrase and token are in .env as ${prefix}_MCP_PASSPHRASE and ${prefix}_MCP_TOKEN."
