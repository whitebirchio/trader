/**
 * Values shared by the stacks. Not secrets: those live in SSM under
 * `/trader/<env>/` and are written by scripts/set-*-secret.sh (SPEC-platform-aws).
 */
export const REGION = "us-east-1";
/**
 * The repo's OIDC tokens use GitHub's immutable subject format, which embeds
 * the org and repo IDs (gh api repos/whitebirchio/trader/actions/oidc/customization/sub).
 * Trusting IDs, not names, means a renamed or re-created "trader" repo can't
 * inherit deploy rights.
 */
export const GITHUB_OIDC_SUBJECT_PREFIX = "repo:whitebirchio@104479267/trader@1440835277";
/**
 * The owner's address: where Trader's email and alarms go, its SES identity,
 * and the only account the dashboard signs in. It's the owner's to set, never
 * in the code: deploys take it from SSM (the address in
 * /trader/production/SEC_USER_AGENT, through scripts/with-owner-email.sh) as
 * OWNER_EMAIL. A plain synth (CI's branch builds, tests) uses a placeholder,
 * which the deploy script refuses.
 */
export const OWNER_EMAIL_PLACEHOLDER = "owner@example.com";
export const OWNER_EMAIL = ownerEmail(process.env.OWNER_EMAIL);

export function ownerEmail(value: string | undefined): string {
  if (value === undefined || value === "") return OWNER_EMAIL_PLACEHOLDER;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new Error("OWNER_EMAIL is not an email address");
  return value;
}
export const MAIL_DOMAIN = "whitebirch.io";
export const NOTIFY_FROM = `trader@${MAIL_DOMAIN}`;
/** CDK's default bootstrap qualifier; the CI role may only assume these roles. */
export const CDK_QUALIFIER = "hnb659fds";

export type TradingEnv = "staging" | "production";

/** The dashboard's public names (SPEC-dashboard); DNS is in Cloudflare (CNAME → CloudFront, DNS only). */
export const DASHBOARD_DOMAINS: Record<TradingEnv, string> = {
  production: `trader.${MAIL_DOMAIN}`,
  staging: `trader-staging.${MAIL_DOMAIN}`,
};
/** The Google OAuth client (a public identifier; its secret is in SSM). One client serves both environments. */
export const GOOGLE_CLIENT_ID = "944410438267-6jg5ik0qpm9t0q4430ja1kv6l3ncs7g9.apps.googleusercontent.com";
export const secretsPath = (env: TradingEnv) => `/trader/${env}/`;
