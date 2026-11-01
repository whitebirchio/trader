#!/usr/bin/env bash
# Write one SecureString to SSM, reading the value from stdin so it never
# appears in argv or shell history.
#
#   printf '%s' "$value" | scripts/put-ssm-secret.sh /trader/staging/NAME
set -euo pipefail
name="${1:?usage: put-ssm-secret.sh /trader/<env>/NAME (value on stdin)}"
node -e '
  let v = ""; process.stdin.on("data", (d) => (v += d)).on("end", () => {
    if (!v) { console.error("empty value"); process.exit(1); }
    process.stdout.write(JSON.stringify({ Name: process.argv[1], Value: v, Type: "SecureString", Overwrite: true }));
  });' "$name" \
  | aws ssm put-parameter --cli-input-json file:///dev/stdin --profile "${AWS_PROFILE:-whitebirch}" --region us-east-1 --output text >/dev/null
echo "✓ $name"
