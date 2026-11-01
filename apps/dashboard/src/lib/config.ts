import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { TradingEnv } from "@trader/core";

/**
 * The dashboard's configuration (SPEC-dashboard). Plain settings come from
 * the Web Function's environment; the three secrets come from SSM by exact
 * name (the role can read nothing else). Fails closed: a missing or short
 * value yields the names that are wrong, never their values.
 */
export interface DashboardConfig {
  env: TradingEnv;
  /** Public origin, e.g. https://trader.whitebirch.io. The app's own Host is the Web Function's, so every absolute URL is built from this. */
  baseUrl: string;
  ownerEmail: string;
  googleClientId: string;
  googleClientSecret: string;
  sessionKey: string;
  databaseReadUrl: string;
  /** Local development only: treat this (owner) email as signed in. */
  devEmail: string | null;
}

export type ConfigResult = { ok: true; config: DashboardConfig } | { ok: false; problems: string[] };

export const SECRET_NAMES = ["DATABASE_READ_URL", "GOOGLE_CLIENT_SECRET", "DASHBOARD_SESSION_KEY"] as const;
const TRADING_ENVS: readonly TradingEnv[] = ["staging", "production"];
const TTL_MS = 15 * 60_000;
let cache: { at: number; values: Record<string, string> } | null = null;
const ssm = new SSMClient({});

async function loadSecrets(env: NodeJS.ProcessEnv, now: number): Promise<Record<string, string | undefined>> {
  const path = env.SECRETS_PATH;
  if (!path) return Object.fromEntries(SECRET_NAMES.map((n) => [n, env[n]])); // local dev: from the environment
  if (cache && now - cache.at < TTL_MS) return cache.values;
  const out = await ssm.send(new GetParametersCommand({ Names: SECRET_NAMES.map((n) => `${path}${n}`), WithDecryption: true }));
  const values: Record<string, string> = {};
  for (const p of out.Parameters ?? []) if (p.Name && p.Value) values[p.Name.slice(path.length)] = p.Value;
  cache = { at: now, values };
  return values;
}

/** Validate settings and secrets. Exported for tests with an explicit environment and secrets. */
export function parseConfig(env: NodeJS.ProcessEnv, secrets: Record<string, string | undefined>): ConfigResult {
  const problems: string[] = [];
  const need = (name: string, value: string | undefined, ok: (v: string) => boolean) => {
    if (!value || !ok(value)) problems.push(name);
    return value ?? "";
  };
  const tradingEnv = need("TRADING_ENV", env.TRADING_ENV, (v) => (TRADING_ENVS as readonly string[]).includes(v));
  const baseUrl = need("DASHBOARD_URL", env.DASHBOARD_URL, (v) => /^https:\/\/[a-z0-9.-]+$/.test(v) || /^http:\/\/localhost(:\d+)?$/.test(v));
  const ownerEmail = need("OWNER_EMAIL", env.OWNER_EMAIL, (v) => /^[^@\s]+@[^@\s]+$/.test(v));
  const googleClientId = need("GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID, (v) => v.endsWith(".apps.googleusercontent.com"));
  const googleClientSecret = need("GOOGLE_CLIENT_SECRET", secrets.GOOGLE_CLIENT_SECRET, (v) => v.length >= 20);
  const sessionKey = need("DASHBOARD_SESSION_KEY", secrets.DASHBOARD_SESSION_KEY, (v) => v.length >= 32);
  const databaseReadUrl = need("DATABASE_READ_URL", secrets.DATABASE_READ_URL, (v) => /^postgres(ql)?:\/\/trader_dashboard:/.test(v));
  if (problems.length > 0) return { ok: false, problems };
  const devEmail = env.NODE_ENV === "development" && env.DASHBOARD_DEV_EMAIL ? env.DASHBOARD_DEV_EMAIL.toLowerCase() : null;
  return {
    ok: true,
    config: { env: tradingEnv as TradingEnv, baseUrl, ownerEmail: ownerEmail.toLowerCase(), googleClientId, googleClientSecret, sessionKey, databaseReadUrl, devEmail },
  };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<ConfigResult> {
  return parseConfig(env, await loadSecrets(env, now));
}
