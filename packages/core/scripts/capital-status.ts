/**
 * Money in and out for one environment: ledger totals, the money-weighted
 * comparison with VTI, the open withdrawal and recent commands. Read-only.
 *
 *   npm run capital:status -w @trader/core -- --env staging|production
 */
import { parseArgs } from "node:util";
import { desc, eq } from "drizzle-orm";
import { accountView, describeWithdrawal, openWithdrawal } from "../src/capital/commands.js";
import { capitalSummary } from "../src/capital/shadow.js";
import { advance } from "../src/capital/withdrawals.js";
import { brokerAccount, capitalCommandResults, capitalCommands, capitalFlows } from "../src/db/schema.js";
import { formatMarketTime, marketDate } from "../src/time.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });

await withOps(values.env, async ({ env, db, broker }) => {
  const now = new Date();
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  const summary = await capitalSummary(db, account?.equity ?? "0");
  const flows = await db.select().from(capitalFlows).orderBy(desc(capitalFlows.at)).limit(10);

  console.log(`Capital — ${env}`);
  console.log(summary ? `  put in $${summary.contributed}, now $${summary.value}; the same flows in VTI: $${summary.sameFlowsInVti ?? "?"}` : "  no transfers recorded");
  for (const f of flows) console.log(`  ${formatMarketTime(f.at)}  ${f.kind.padEnd(10)} ${f.amount.padStart(12)}  ${f.status ?? ""}${f.timedBy === "booking_date" ? " (timed by booking date)" : ""}`);

  const w = await openWithdrawal(db);
  if (w) {
    const calendar = await broker.getCalendar(marketDate(new Date(now.getTime() - 10 * 86_400_000)), marketDate(new Date(now.getTime() + 21 * 86_400_000)));
    const view = await accountView(db, w, now, calendar);
    console.log(`  open withdrawal  ${describeWithdrawal(w, account?.equity ?? "0")}`);
    if (view) console.log(`  next            ${advance(w, view, now).reason}`);
  } else {
    console.log("  open withdrawal  none");
  }

  const commands = await db
    .select({ c: capitalCommands, r: capitalCommandResults })
    .from(capitalCommands)
    .leftJoin(capitalCommandResults, eq(capitalCommandResults.commandId, capitalCommands.id))
    .orderBy(desc(capitalCommands.at))
    .limit(5);
  for (const { c, r } of commands) {
    console.log(`  command  ${formatMarketTime(c.at)}  ${c.kind} ${c.amount ?? ""} by ${c.requestedBy}: ${r ? `${r.outcome}${r.reason ? ` (${r.reason})` : ""}` : "pending"}`);
  }
});
