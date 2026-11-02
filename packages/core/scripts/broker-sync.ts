/**
 * Run one broker sync by hand, outside the cron, and print the verdict.
 * --force ignores the market-session gate (no equity snapshot).
 *
 *   npm run broker:sync -w @trader/core -- --env staging [--force]
 *   npm run broker:sync -w @trader/core -- --env production --force
 *
 * Production is allowed only with --force: in session its own cron syncs, so
 * this exists for the gap before the first session (e.g. a weekend deploy). A
 * sync reads Alpaca and writes the mirror only. It never places an order.
 */
import { parseArgs } from "node:util";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import { syncBroker } from "../src/broker/sync.js";
import { recordCapitalFlows } from "../src/capital/ledger.js";
import type { Db } from "../src/db/client.js";
import { readRepoEnv } from "./repo-env.js";

const { values } = parseArgs({ options: { env: { type: "string" }, force: { type: "boolean" } } });
const env = values.env;
if (env !== "staging" && env !== "production") throw new Error("--env staging|production is required");
if (env === "production" && !values.force) throw new Error("production syncs come from its cron; --force is for the gap before a session");
const prefix = env === "staging" ? "STAGING" : "PRODUCTION";

const repo = readRepoEnv();
const broker = new AlpacaBroker({
  env,
  keyId: repo.require(`${prefix}_ALPACA_KEY_ID`),
  secretKey: repo.require(`${prefix}_ALPACA_SECRET_KEY`),
});
const pool = new Pool({ connectionString: repo.require(`${prefix}_MIGRATE_URL`) });
try {
  const db = drizzle(pool, { casing: "snake_case" }) as unknown as Db;
  const result = await syncBroker(db, broker, env, new Date(), { ignoreSession: values.force });
  const capital = result.status === "synced" ? await recordCapitalFlows(db) : null;
  console.log(JSON.stringify({ ...result, capital }, null, 2));
} finally {
  await pool.end();
}
