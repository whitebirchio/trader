/**
 * Run one broker sync by hand against STAGING, outside the cron, and print the
 * verdict. --force ignores the market-session gate (no equity snapshot).
 *
 *   npm run broker:sync -w @trader/core -- --env staging [--force]
 *
 * Staging only: production syncs come from its own cron.
 */
import { parseArgs } from "node:util";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import { syncBroker } from "../src/broker/sync.js";
import type { Db } from "../src/db/client.js";
import { readRepoEnv } from "./repo-env.js";

const { values } = parseArgs({ options: { env: { type: "string" }, force: { type: "boolean" } } });
if (values.env !== "staging") throw new Error("broker:sync only runs with --env staging");

const repo = readRepoEnv();
const broker = new AlpacaBroker({
  env: "staging",
  keyId: repo.require("STAGING_ALPACA_KEY_ID"),
  secretKey: repo.require("STAGING_ALPACA_SECRET_KEY"),
});
const pool = new Pool({ connectionString: repo.require("STAGING_MIGRATE_URL") });
try {
  const db = drizzle(pool, { casing: "snake_case" }) as unknown as Db;
  const result = await syncBroker(db, broker, "staging", new Date(), { ignoreSession: values.force });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
