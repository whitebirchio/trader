import { z } from "zod";
import { TRADING_ENVS, type TradingEnv } from "./env.js";

export interface Config {
  tradingEnv: TradingEnv;
  databaseUrl: string;
  /** The env's own Alpaca key pair: paper in staging, live in production (ADR-005). */
  alpaca: { keyId: string; secretKey: string };
  /** Alpha Vantage's key for the earnings calendar (#30). Optional: without it the earnings-calendar job skips. */
  alphaVantageKey: string | null;
  /**
   * Each research routine's API token, by trigger id (SPEC-agent § Missed-run
   * recovery). Optional: without it check-routine alerts and doesn't retry.
   */
  routineFireTokens: Record<string, string> | null;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; missing: string[]; invalid: string[] };

// Each var maps to one schema so failures can be reported per name. Messages
// never carry the received value: DATABASE_URL holds a password.
/**
 * The MCP server's own SSM parameters (least privilege, review finding R1).
 * Its IAM role (infra) reads exactly these names, and apps/mcp loads exactly
 * these: never the engine's DATABASE_URL or Alpaca keys.
 */
export const MCP_PARAMETERS = ["MCP_DATABASE_URL", "MCP_ALPACA_KEY_ID", "MCP_ALPACA_SECRET_KEY", "MCP_TOKEN", "MCP_PASSPHRASE", "MCP_SIGNING_KEY"] as const;

/**
 * The engine's own SSM parameters, read by name like MCP_PARAMETERS. Its IAM
 * role (infra) reads exactly these, never the MCP server's or the
 * dashboard's: each decrypted SecureString is a KMS request, and reading the
 * whole path decrypted all of them on every tick.
 */
export const ENGINE_PARAMETERS = ["DATABASE_URL", "ALPACA_KEY_ID", "ALPACA_SECRET_KEY", "ALPHAVANTAGE_API_KEY", "ROUTINE_FIRE_TOKENS"] as const;

const VARS = {
  TRADING_ENV: z.enum(TRADING_ENVS),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/),
  ALPACA_KEY_ID: z.string().regex(/^[A-Z0-9]{16,}$/),
  ALPACA_SECRET_KEY: z.string().regex(/^[A-Za-z0-9]{32,}$/),
} as const;

/** Optional: missing is fine, but a value that's set must be valid (fails closed like the rest). */
/** `{ "trig_…": "sk-ant-oat01-…" }` as JSON, one routine or more. */
const routineFireTokens = z
  .string()
  .transform((v, ctx) => {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string().regex(/^trig_\w{10,64}$/), z.string().regex(/^sk-ant-oat01-[\w-]{10,256}$/)).refine((r) => Object.keys(r).length > 0));

const OPTIONAL = {
  ALPHAVANTAGE_API_KEY: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
  ROUTINE_FIRE_TOKENS: routineFireTokens,
} as const;

type VarName = keyof typeof VARS | keyof typeof OPTIONAL;

/**
 * Validate the Worker's environment. Fails closed: callers must not run jobs
 * or serve routes on `ok: false`, and should report only the names returned.
 */
export function parseConfig(env: Partial<Record<VarName, unknown>>): ConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const names = Object.keys(VARS).sort() as VarName[];

  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === null || value === "") {
      missing.push(name);
    } else if (!VARS[name as keyof typeof VARS].safeParse(value).success) {
      invalid.push(name);
    }
  }
  for (const name of Object.keys(OPTIONAL) as (keyof typeof OPTIONAL)[]) {
    const value = env[name];
    if (value !== undefined && value !== null && value !== "" && !OPTIONAL[name].safeParse(value).success) invalid.push(name);
  }
  invalid.sort();

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return {
    ok: true,
    config: {
      tradingEnv: VARS.TRADING_ENV.parse(env.TRADING_ENV),
      databaseUrl: VARS.DATABASE_URL.parse(env.DATABASE_URL),
      alpaca: {
        keyId: VARS.ALPACA_KEY_ID.parse(env.ALPACA_KEY_ID),
        secretKey: VARS.ALPACA_SECRET_KEY.parse(env.ALPACA_SECRET_KEY),
      },
      alphaVantageKey: typeof env.ALPHAVANTAGE_API_KEY === "string" && env.ALPHAVANTAGE_API_KEY !== "" ? env.ALPHAVANTAGE_API_KEY : null,
      routineFireTokens: typeof env.ROUTINE_FIRE_TOKENS === "string" && env.ROUTINE_FIRE_TOKENS !== "" ? OPTIONAL.ROUTINE_FIRE_TOKENS.parse(env.ROUTINE_FIRE_TOKENS) : null,
    },
  };
}
