/**
 * Shared plumbing for operator scripts: parse --env, open that environment's
 * database (owner role, from .env) and its own Alpaca account. Owner scripts
 * run on Scott's machine; production use is Scott's to run.
 */
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import type { Db } from "../src/db/client.js";
import { TRADING_ENVS, type TradingEnv } from "../src/env.js";
import { readRepoEnv } from "./repo-env.js";

export async function withOps<T>(
  envArg: string | undefined,
  fn: (ops: { env: TradingEnv; db: Db; broker: AlpacaBroker }) => Promise<T>,
): Promise<T> {
  const env = envArg as TradingEnv;
  if (!TRADING_ENVS.includes(env)) throw new Error("--env staging|production is required");
  const repo = readRepoEnv();
  const prefix = env.toUpperCase();
  const broker = new AlpacaBroker({
    env,
    keyId: repo.require(`${prefix}_ALPACA_KEY_ID`),
    secretKey: repo.require(`${prefix}_ALPACA_SECRET_KEY`),
  });
  const pool = new Pool({ connectionString: repo.require(`${prefix}_MIGRATE_URL`) });
  try {
    return await fn({ env, db: drizzle(pool, { casing: "snake_case" }) as unknown as Db, broker });
  } finally {
    await pool.end();
  }
}

export function requireReason(reason: string | undefined): string {
  if (!reason || reason.trim().length < 3) throw new Error('--reason "…" is required (it goes in the audit log)');
  return reason.trim();
}
