/**
 * Run one broker sync by hand, outside the cron, and print the verdict.
 * --force ignores the market-session gate (no equity snapshot).
 *
 *   npm run broker:sync -w @trader/core -- --env paper [--force]
 *   npm run broker:sync -w @trader/core -- --env production --force
 *
 * Production is allowed only with --force: in session its own cron syncs, so
 * this exists for the gap before the first session (e.g. a weekend deploy). A
 * sync reads Alpaca and writes the mirror only. It never places an order.
 */
import { parseArgs } from "node:util";
import { syncBroker } from "../src/broker/sync.js";
import { recordCapitalFlows } from "../src/capital/ledger.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, force: { type: "boolean" } } });
if (values.env === "production" && !values.force) throw new Error("production syncs come from its cron; --force is for the gap before a session");

await withOps(values.env, async ({ env, db, broker }) => {
  const result = await syncBroker(db, broker, env, new Date(), { ignoreSession: values.force });
  const capital = result.status === "synced" ? await recordCapitalFlows(db, new Date()) : null;
  console.log(JSON.stringify({ ...result, capital }, null, 2));
});
