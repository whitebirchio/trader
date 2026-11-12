/**
 * Run the daily check by hand, without waiting for its schedule.
 *
 *   npm run rebalance:plan -w @trader/core -- --env production|paper   # dry run through risk: records and orders nothing
 *   npm run rebalance:run  -w @trader/core -- --env paper              # one real step on PAPER, ignoring the window
 *
 * `run` refuses production: live orders only come from the scheduled job.
 * --sync runs a broker sync first (ignoring market hours), so risk sees fresh data.
 */
import { parseArgs } from "node:util";
import { syncBroker } from "../src/broker/sync.js";
import { runRebalance } from "../src/portfolio/rebalance.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, mode: { type: "string" }, sync: { type: "boolean" } } });
const dryRun = values.mode !== "run";
if (!dryRun && values.env !== "paper") throw new Error("rebalance:run is paper-only; production trades only on its schedule");

await withOps(values.env, async ({ env, db, broker }) => {
  if (values.sync) await syncBroker(db, broker, env, new Date(), { ignoreSession: true });
  const result = await runRebalance(db, broker, env, new Date(), { force: true, dryRun });
  if (result.status === "skipped") return console.log(`${env}: ${result.reason}`);
  console.log(`${env} · strategy v${result.strategyVersion} · ${dryRun ? "DRY RUN" : "placed"} · phase: ${result.phase}`);
  for (const { trade, decision, submitted } of result.trades) {
    const p = trade.proposal;
    const size = p.side === "buy" ? `$${decision?.notional ?? p.notional}` : `${decision?.qty ?? p.qty} sh`;
    console.log(`  ${p.side.toUpperCase().padEnd(4)} ${p.symbol.padEnd(5)} ${size.padStart(10)}  [${p.sleeve}] ${decision ? decision.verdict.toUpperCase() : ""}${submitted ? ` → ${submitted}` : ""}`);
    console.log(`        ${trade.reason}`);
    for (const r of decision?.reasons ?? []) console.log(`        risk: ${r}`);
  }
  if (result.notes.length) console.log(`\n  Notes:\n${result.notes.map((n) => `    · ${n}`).join("\n")}`);
});
