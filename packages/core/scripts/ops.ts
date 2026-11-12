/**
 * Shared plumbing for operator scripts: parse --env, open that environment's
 * database and its own Alpaca account. Owner scripts run on Scott's machine;
 * production use is Scott's to run, except the read-only checks below.
 *
 *   --env production   the owner role (PRODUCTION_MIGRATE_URL) and the live keys
 *   --env paper        the paper rehearsal (ADR-018): the paper keys and a local
 *                      database in .cache/paper-db, kept between commands and
 *                      rebuilt when the migrations change. Delete it to start over.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/neon-serverless";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import { MarketDataOnly } from "../src/broker/market-data.js";
import type { Db } from "../src/db/client.js";
import { writableTables } from "../src/db/read-only.js";
import type { TradingEnv } from "../src/env.js";
import { migratedPglite } from "../src/replay/db.js";
import { readRepoEnv } from "./repo-env.js";

const ENVS = ["production", "paper"] as const;
export type OpsEnv = (typeof ENVS)[number];

const PAPER_DB = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "paper-db");
const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "meta", "_journal.json");

/** The paper keys: market data for every env, and the paper account for --env paper. */
export function paperBroker(): AlpacaBroker {
  const repo = readRepoEnv();
  return new AlpacaBroker({ env: "staging", keyId: repo.require("STAGING_ALPACA_KEY_ID"), secretKey: repo.require("STAGING_ALPACA_SECRET_KEY") });
}

/** The paper rehearsal's database: reopened while the migrations match, rebuilt from scratch when they don't. */
async function paperDb(): Promise<{ db: Db; close(): Promise<void> }> {
  const marker = join(PAPER_DB, "trader-journal.json");
  const journal = readFileSync(JOURNAL, "utf8");
  let pglite: PGlite;
  if (existsSync(marker) && readFileSync(marker, "utf8") === journal) pglite = new PGlite(PAPER_DB);
  else {
    rmSync(PAPER_DB, { recursive: true, force: true });
    pglite = await migratedPglite(PAPER_DB);
    writeFileSync(marker, journal);
    console.error(`paper: built a new local database in ${PAPER_DB}`);
  }
  return { db: pgliteDrizzle(pglite, { casing: "snake_case" }) as unknown as Db, close: () => pglite.close() };
}

export function parseOpsEnv(envArg: string | undefined): OpsEnv {
  if (envArg === "staging") throw new Error("staging was retired (ADR-018): use --env paper for the paper account on a local database");
  if (!ENVS.includes(envArg as OpsEnv)) throw new Error("--env production|paper is required");
  return envArg as OpsEnv;
}

/** The TradingEnv the core runs as: paper is "staging", the not-live value. */
export const tradingEnv = (env: OpsEnv): TradingEnv => (env === "paper" ? "staging" : "production");

export async function withOps<T>(
  envArg: string | undefined,
  fn: (ops: { env: TradingEnv; db: Db; broker: AlpacaBroker }) => Promise<T>,
): Promise<T> {
  const env = parseOpsEnv(envArg);
  const repo = readRepoEnv();
  const broker =
    env === "paper" ? paperBroker() : new AlpacaBroker({ env: "production", keyId: repo.require("PRODUCTION_ALPACA_KEY_ID"), secretKey: repo.require("PRODUCTION_ALPACA_SECRET_KEY") });
  if (env === "paper") {
    const { db, close } = await paperDb();
    try {
      return await fn({ env: "staging", db, broker });
    } finally {
      await close();
    }
  }
  const pool = new Pool({ connectionString: repo.require("PRODUCTION_MIGRATE_URL") });
  try {
    return await fn({ env: "production", db: drizzle(pool, { casing: "snake_case" }) as unknown as Db, broker });
  } finally {
    await pool.end();
  }
}

/**
 * For the read-only checks Claude may run against production (ADR-018):
 * trader_readonly, a SELECT-only role (scripts/set-readonly-secret.sh; not the
 * dashboard's, which can INSERT owner withdrawal commands), its URL read from SSM so no copy sits in
 * .env, and market data through the paper key. No owner role and no live key,
 * so nothing run through it can write or trade, and it refuses a connection
 * whose role could change any table. --env paper reads the local rehearsal
 * database instead.
 */
export async function withReadOnly<T>(envArg: string | undefined, fn: (ops: { env: TradingEnv; db: Db; market: MarketDataOnly }) => Promise<T>): Promise<T> {
  const env = parseOpsEnv(envArg);
  const market = new MarketDataOnly(paperBroker());
  if (env === "paper") {
    const { db, close } = await paperDb();
    try {
      return await fn({ env: "staging", db, market });
    } finally {
      await close();
    }
  }
  const url = execFileSync(
    "aws",
    ["ssm", "get-parameter", "--name", "/trader/production/READONLY_DATABASE_URL", "--with-decryption", "--query", "Parameter.Value", "--output", "text", "--region", "us-east-1", "--profile", process.env.AWS_PROFILE ?? "whitebirch"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
  const pool = new Pool({ connectionString: url });
  try {
    const db = drizzle(pool, { casing: "snake_case" }) as unknown as Db;
    const writable = await writableTables(db);
    if (writable.length > 0) throw new Error(`refusing: this connection can change ${writable.length} tables (${writable.slice(0, 3).join(", ")}…), so it isn't the read-only role`);
    return await fn({ env: "production", db, market });
  } finally {
    await pool.end();
  }
}

export function requireReason(reason: string | undefined): string {
  if (!reason || reason.trim().length < 3) throw new Error('--reason "…" is required (it goes in the audit log)');
  return reason.trim();
}
