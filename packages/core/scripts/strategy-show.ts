/**
 * Show the active strategy (or --version N) and each thesis's current state.
 *
 *   npm run strategy:show -w @trader/core -- --env production|paper [--version N]
 */
import { parseArgs } from "node:util";
import { asc, eq } from "drizzle-orm";
import { buildLots } from "../src/broker/lots.js";
import { brokerActivities, positions, strategies } from "../src/db/schema.js";
import { activeStrategy, stoppedThesisIds } from "../src/portfolio/store.js";
import { validateStrategy } from "../src/portfolio/strategy.js";
import { thesisStates } from "../src/portfolio/theses.js";
import { withReadOnly } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, version: { type: "string" } } });

await withReadOnly(values.env, async ({ env, db }) => {
  const now = new Date();
  let shown = await activeStrategy(db, now);
  if (values.version) {
    const [row] = await db.select().from(strategies).where(eq(strategies.version, Number(values.version)));
    if (!row) throw new Error(`no strategy v${values.version}`);
    const parsed = validateStrategy(row.document);
    if (!parsed.ok) throw new Error(`v${row.version} no longer validates: ${parsed.errors.join("; ")}`);
    // A past version's staleness is shown as of its own date.
    shown = { version: row.version, authoredBy: row.authoredBy, createdAt: row.createdAt, reaffirmedAt: row.createdAt, strategy: parsed.strategy };
  }
  const s = shown.strategy;
  console.log(`${env}: strategy v${shown.version} by ${shown.authoredBy}, ${shown.createdAt.toISOString()}`);
  console.log(`  ${s.summary}`);

  const acts = await db.select().from(brokerActivities).orderBy(asc(brokerActivities.at), asc(brokerActivities.id));
  const lots = buildLots(acts.map((r) => ({ ...r, side: r.side === "buy" || r.side === "sell" ? r.side : null })));
  const held = await db.select().from(positions);
  const lastClose = Object.fromEntries(held.map((p) => [p.symbol, p.currentPrice]));
  const states = thesisStates({ active: { strategy: s, createdAt: shown.createdAt, reaffirmedAt: shown.reaffirmedAt }, stoppedIds: await stoppedThesisIds(db), lots: lots.open, lastClose, now });

  console.log(`\n  Conviction (${s.conviction.length})`);
  for (const st of states) {
    const t = st.thesis;
    const pos = held.find((p) => p.symbol === t.symbol);
    console.log(`    ${t.id} · ${t.symbol} · ${t.targetWeightPct}% · stop ${t.stopLossPct}% · ${st.state.toUpperCase()}${st.state === "active" ? "" : ` (${st.reason})`}${pos ? ` · held $${pos.marketValue}` : ""}`);
  }
  const p = s.systematic;
  console.log(`\n  Systematic: top ${p.topN} of ${p.universe.length} by ${p.lookbackDays}-day momentum (skip ${p.skipRecentDays}), trend ${p.trendFilterDays ?? "off"}, ${p.weighting}, defensive ${p.defensive ?? "VTI"}`);
  console.log(`  Drift: trade when ${s.drift.relativePct}% off target (min $${s.drift.minTradeUsd})`);
  console.log(`\n  Holdings: ${held.length ? held.map((h) => `${h.symbol} $${h.marketValue}`).join(", ") : "none"}`);
});
