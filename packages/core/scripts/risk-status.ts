/**
 * Show the guardrails' current state for one environment.
 *
 *   npm run risk:status -w @trader/core -- --env staging|production
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { brokerAccount } from "../src/db/schema.js";
import { checkDrawdownReadOnly } from "./risk-readonly.js";
import { LIMITS, limitsVersion } from "../src/risk/limits.js";
import { getRiskState } from "../src/risk/state.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });

await withOps(values.env, async ({ env, db }) => {
  const state = await getRiskState(db);
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  const index = await checkDrawdownReadOnly(db, new Date());
  const age = account ? Math.round((Date.now() - account.syncedAt.getTime()) / 60_000) : null;

  console.log(`Risk status — ${env}`);
  console.log(`  kill switch     ${state.killSwitch ? `ON (${state.killReason})` : "off"}`);
  console.log(`  drawdown halt   ${state.halted ? `HALTED since ${state.haltedAt?.toISOString()} (${state.haltReason})` : "not halted"}`);
  console.log(`  drawdown        ${index.drawdownPct}% from peak (halt at ${LIMITS.drawdownHaltPct}%)`);
  console.log(`  today           ${index.dailyChangePct}% vs prior close (buys pause at -${LIMITS.dailyLossPausePct}%)`);
  if (account) {
    console.log(`  broker verdict  ${account.tradingAllowed ? "trading allowed" : `BLOCKED: ${account.blockedReasons.join("; ")}`}`);
    console.log(`  account         equity $${account.equity}, cash $${account.cash}, last synced ${age} min ago`);
  } else {
    console.log("  broker verdict  never synced");
  }
  console.log(`  limits          version ${await limitsVersion()} (packages/core/src/risk/limits.ts)`);
});
