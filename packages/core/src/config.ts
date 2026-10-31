import { z } from "zod";
import { TRADING_ENVS, type TradingEnv } from "./env.js";

export interface Config {
  tradingEnv: TradingEnv;
  databaseUrl: string;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; missing: string[]; invalid: string[] };

// Each var maps to one schema so failures can be reported per name. Messages
// never carry the received value: DATABASE_URL holds a password.
const VARS = {
  TRADING_ENV: z.enum(TRADING_ENVS),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/),
} as const;

type VarName = keyof typeof VARS;

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
    } else if (!VARS[name].safeParse(value).success) {
      invalid.push(name);
    }
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return {
    ok: true,
    config: {
      tradingEnv: VARS.TRADING_ENV.parse(env.TRADING_ENV),
      databaseUrl: VARS.DATABASE_URL.parse(env.DATABASE_URL),
    },
  };
}
