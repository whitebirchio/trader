/**
 * Show each held thesis against the event triggers (SPEC-agent § Event-triggered
 * runs): its price, how far above its stop, and its move from the previous
 * close, then today's recorded trips. Read-only.
 *
 *   npm run events:status -w @trader/core -- --env production|paper
 */
import { parseArgs } from "node:util";
import { and, eq, like } from "drizzle-orm";
import { EVENT_RUNS, loadTriggerInput, watchStatus } from "../src/agent/events.js";
import { auditEvents } from "../src/db/schema.js";
import { formatMarketTime, marketDate } from "../src/time.js";
import { withReadOnly } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });

await withReadOnly(values.env, async ({ env, db }) => {
  const now = new Date();
  const today = marketDate(now);
  const { input, version } = await loadTriggerInput(db, now);
  console.log(`${env}: event triggers at ${formatMarketTime(now)} (strategy v${version}): near stop ≤ ${EVENT_RUNS.nearStopPct}% above it, move ≥ ${EVENT_RUNS.movePct}% from the previous close`);
  const rows = watchStatus(input);
  if (!rows.length) console.log("  No held theses.");
  for (const r of rows) {
    const near = r.abovePct !== null && Number(r.abovePct) <= Number(EVENT_RUNS.nearStopPct) ? "  ← near stop" : "";
    const moved = r.movePct !== null && Math.abs(Number(r.movePct)) >= Number(EVENT_RUNS.movePct) ? "  ← move" : "";
    console.log(
      `  ${r.symbol.padEnd(6)} ${r.price ? `$${r.price}` : "no price"} · stop $${Number(r.stop).toFixed(2)}, ${r.abovePct ?? "–"}% above${near} · previous close ${r.previousClose ? `$${r.previousClose}` : "–"}, ${r.movePct ?? "–"}%${moved}${r.boughtToday ? " · bought today (price triggers skip it)" : ""}`,
    );
  }
  for (const f of input.sellFilings) console.log(`  sell-signal filing today: ${f.symbol} (${f.form}) ${f.summary}`);

  const trips = await db
    .select({ at: auditEvents.at, payload: auditEvents.payload })
    .from(auditEvents)
    .where(and(eq(auditEvents.kind, "events.tripped"), like(auditEvents.subject, `${today}#%`)));
  console.log(`\n  Trips recorded today (${trips.length})`);
  for (const t of trips) console.log(`    ${formatMarketTime(t.at)}: ${String((t.payload as { detail?: unknown }).detail ?? "")}`);
});
