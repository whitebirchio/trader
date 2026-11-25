#!/usr/bin/env bash
# Run a cdk command that deploys or diffs TraderProduction with the owner's
# address as OWNER_EMAIL (infra/lib/config.ts), never written in the code.
# It's the address in /trader/production/SEC_USER_AGENT ("Name address"),
# the contact the owner set with scripts/set-sec-user-agent.sh.
#
#   scripts/with-owner-email.sh cdk deploy TraderProduction …
#
# In CI the deploy role reads it (TraderCi grants exactly that parameter) and
# the address is masked in the logs; on the laptop, the whitebirch profile.
# Refuses to run without a real address: a deploy with the placeholder would
# move the SES identity, the alarm subscription and the dashboard's sign-in.
set -euo pipefail

if [ -z "${OWNER_EMAIL:-}" ]; then
  profile=()
  [ -n "${GITHUB_ACTIONS:-}" ] || profile=(--profile "${AWS_PROFILE:-whitebirch}")
  contact="$(aws ssm get-parameter --name /trader/production/SEC_USER_AGENT --with-decryption \
    --query Parameter.Value --output text --region us-east-1 "${profile[@]}")"
  OWNER_EMAIL="${contact##* }"
fi
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::${OWNER_EMAIL}"
case "$OWNER_EMAIL" in
  *@*.*) ;;
  *) echo "with-owner-email: no owner address (set SEC_USER_AGENT with scripts/set-sec-user-agent.sh)" >&2; exit 1 ;;
esac
case "$OWNER_EMAIL" in
  *@example.com) echo "with-owner-email: refusing the placeholder address" >&2; exit 1 ;;
esac
export OWNER_EMAIL
exec "$@"
