/**
 * Values shared by the stacks. Not secrets: those live in SSM under
 * `/trader/<env>/` and are written by scripts/set-*-secret.sh (SPEC-platform-aws).
 */
export const REGION = "us-east-1";
export const GITHUB_REPO = "whitebirchio/trader";
export const OWNER_EMAIL = "scott.schmalz@gmail.com";
export const MAIL_DOMAIN = "whitebirch.io";
export const NOTIFY_FROM = `trader@${MAIL_DOMAIN}`;
/** CDK's default bootstrap qualifier; the CI role may only assume these roles. */
export const CDK_QUALIFIER = "hnb659fds";

export type TradingEnv = "staging" | "production";
export const secretsPath = (env: TradingEnv) => `/trader/${env}/`;
