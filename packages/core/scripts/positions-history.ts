/**
 * The position history (SPEC-dashboard Amendment 3 § Position history), read
 * only: each recorded session's equity split into cash, positions at the
 * official close, and the after-close pricing that reconciles them, plus what
 * the position-history job would write next (valued now, written nothing).
 *
 *   npm run positions:history -w @trader/core -- --env production|paper
 */
import Big from "big.js";
import { parseArgs } from "node:util";
import { buildRows, dayValues, missingDays } from "../src/portfolio/position-history.js";
import { withReadOnly } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });

await withReadOnly(values.env, async ({ env, db, market }) => {
  const now = new Date();
  const pending = await buildRows(market, await missingDays(db, now), now);
  const pendingByDay = new Map<string, string>();
  for (const r of pending.rows) if (r.marketValue !== null) pendingByDay.set(r.tradingDate, new Big(pendingByDay.get(r.tradingDate) ?? "0").plus(r.marketValue).toFixed(2));
  console.log(`${env}: position history (official closes) against each day's recorded equity`);
  console.log("  date        equity      cash        positions   after-close pricing");
  for (const d of await dayValues(db)) {
    const positions = d.positions ?? pendingByDay.get(d.tradingDate) ?? null;
    const pricing = positions !== null && d.cash !== null ? new Big(d.equity).minus(d.cash).minus(positions).toFixed(2) : "–";
    const mark = d.positions === null && positions !== null ? "  (not written yet)" : "";
    console.log(`  ${d.tradingDate}  ${d.equity.padStart(10)}  ${(d.cash ?? "–").padStart(10)}  ${(positions ?? "–").padStart(10)}  ${pricing.padStart(10)}${mark}`);
  }
  console.log(`\n  The job would write ${pending.rows.length} rows for ${new Set(pending.rows.map((r) => r.tradingDate)).size} days.`);
  if (pending.waiting.length) console.log(`  Waiting for bars: ${pending.waiting.join(", ")}`);
  if (pending.gaps.length) console.log(`  Gaps (no close; written as unknown): ${pending.gaps.join(", ")}`);
});
