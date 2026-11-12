/**
 * Fetch today's earnings calendar now (#30), without waiting for the
 * earnings-calendar tick job: the same refresh, with the Alpha Vantage key
 * from the repo's .env (ALPHAVANTAGE_API_KEY), against the env's database.
 * Spends one of the free tier's 25 requests a day, and none if today's
 * snapshot is already stored. Prints counts only, never the key.
 *
 *   npm run earnings:refresh -w @trader/core -- --env production|paper [--show AAPL,LKQ]
 */
import { parseArgs } from "node:util";
import { AlphaVantageCalendar, nextEarnings, refreshEarningsCalendar } from "../src/agent/earnings-calendar.js";
import { withOps } from "./ops.js";
import { readRepoEnv } from "./repo-env.js";

const { values } = parseArgs({ options: { env: { type: "string" }, show: { type: "string" } } });
const key = readRepoEnv().require("ALPHAVANTAGE_API_KEY");

await withOps(values.env, async ({ env, db }) => {
  const now = new Date();
  const result = await refreshEarningsCalendar(db, new AlphaVantageCalendar(key), now);
  console.log(`${env}: ${result.status === "refreshed" ? `stored ${result.rows} reports for ${result.fetchedOn} (pruned ${result.pruned} old rows)` : result.reason}`);
  if (values.show) {
    const symbols = values.show.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const view = await nextEarnings(db, symbols, now);
    for (const s of symbols) {
      const n = view.next.get(s);
      console.log(`  ${s.padEnd(6)} ${n ? `${n.date} (in ${n.inDays} days${n.timeOfDay ? `, ${n.timeOfDay}` : ""}${n.estimate ? `, EPS estimate ${n.estimate}` : ""})` : "no date announced yet"}`);
    }
  }
});
