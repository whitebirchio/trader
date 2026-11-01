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
export const OWNER_EMAIL = "scott.schmalz@gmail.com";
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
