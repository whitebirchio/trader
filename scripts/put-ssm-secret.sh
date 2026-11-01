#!/usr/bin/env bash
# Write one SecureString to SSM, reading the value from stdin so it never
# appears in argv or shell history.
#
#   printf '%s' "$value" | scripts/put-ssm-secret.sh /trader/staging/NAME
#
# The AWS CLI on macOS can't read --cli-input-json from /dev/stdin, so the
# request goes through a private temp file (mode 600, per-user temp dir) that
# is removed when the script exits, even on error.
set -euo pipefail
name="${1:?usage: put-ssm-secret.sh /trader/<env>/NAME (value on stdin)}"

umask 077
tmp="$(mktemp "${TMPDIR:-/tmp}/trader-ssm.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

node -e '
  let v = ""; process.stdin.on("data", (d) => (v += d)).on("end", () => {
    if (!v) { console.error("empty value"); process.exit(1); }
    process.stdout.write(JSON.stringify({ Name: process.argv[1], Value: v, Type: "SecureString", Overwrite: true }));
  });' "$name" > "$tmp"

aws ssm put-parameter --cli-input-json "file://$tmp" --profile "${AWS_PROFILE:-whitebirch}" --region us-east-1 --output text >/dev/null
echo "✓ $name"
