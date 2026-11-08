/**
 * Show the thesis scorecard: each thesis ever held, its return, and the same
 * dollars in VTI (SPEC-portfolio § Scorecard). Read-only.
 *
 *   npm run scorecard:show -w @trader/core -- --env staging|production
 */
import { parseArgs } from "node:util";
import type { ScorecardRollUp } from "../src/portfolio/scorecard.js";
import { loadScorecard } from "../src/portfolio/scorecard.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });

/** Display only: two decimals ("47.80", not "47.8"). */
const usd = (v: string) => {
  const [whole, frac = ""] = v.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
};
const signed = (v: string) => (v.startsWith("-") ? `-$${usd(v.slice(1))}` : `+$${usd(v)}`);
const summary = (r: ScorecardRollUp) =>
  `${r.scored}/${r.theses} scored, ${r.closed} closed · bought $${usd(r.bought)} · P&L ${signed(r.pnl)} vs VTI ${signed(r.vtiPnl)} · excess ${signed(r.excess)} (${r.excessPct ?? "–"}%) · beat VTI ${r.beatVtiPct ?? "–"}% · median ${r.medianDaysHeld ?? "–"} days`;

await withOps(values.env, async ({ env, db }) => {
  const card = await loadScorecard(db, new Date());
  console.log(`${env}: scorecard, marked ${card.markedAt?.toISOString() ?? "never (no positions)"}`);
  console.log(`  Overall: ${summary(card.overall)}`);
  for (const k of card.byKind) console.log(`  ${k.kind}: ${summary(k)}`);

  console.log(`\n  Theses (${card.theses.length})`);
  for (const r of card.theses) {
    const when = `${r.openedAt.toISOString().slice(0, 10)} → ${r.closedAt?.toISOString().slice(0, 10) ?? "held"}`;
    const head = `    ${r.ids.join(" → ")} · ${r.symbol} · ${r.primaryKind ?? "no evidence"} · ${r.ending} · ${when} (${r.daysHeld}d) · qty ${r.qty}`;
    if (!r.money) {
      console.log(`${head}\n      UNSCORED: ${r.unscored}`);
      continue;
    }
    const m = r.money;
    console.log(`${head}\n      bought $${usd(m.bought)} · sold $${usd(m.proceeds)} · div $${usd(m.dividends)} · value $${usd(m.marketValue)} · P&L ${signed(m.pnl)} (${m.returnPct}%) · VTI ${signed(m.vtiPnl)} (${m.vtiPct}%) · excess ${signed(m.excess)} (${m.excessPct}%)`);
  }
});
