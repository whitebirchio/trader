/**
 * OWNER: queue a withdrawal command (the same row the dashboard writes), then
 * process it right away rather than waiting for the next tick.
 *
 *   npm run capital:withdraw -w @trader/core -- --env staging|production --amount 500   (or --amount all)
 *   npm run capital:fund-now -w @trader/core -- --env staging|production
 *   npm run capital:cancel   -w @trader/core -- --env staging|production
 *
 * Nothing here moves money out of Alpaca: a request sells holdings and holds
 * the cash; you start the transfer in Alpaca when it's ready.
 */
import { parseArgs } from "node:util";
import { type CommandKind, processCapital, queueCommand } from "../src/capital/commands.js";
import { withOps } from "./ops.js";

const KINDS: Record<string, CommandKind> = { request: "request", cancel: "cancel", "fund-now": "fund_now" };
const { values, positionals } = parseArgs({ options: { env: { type: "string" }, amount: { type: "string" } }, allowPositionals: true });
const kind = KINDS[positionals[0] ?? ""];
if (!kind) throw new Error(`usage: capital-command.ts request|cancel|fund-now --env … [--amount …]`);
if (kind === "request" && !values.amount) throw new Error("--amount <dollars>|all is required");

await withOps(values.env, async ({ env, db, broker }) => {
  const command = await queueCommand(db, { kind, amount: kind === "request" ? values.amount : null, requestedBy: "cli" }, new Date());
  const result = await processCapital(db, broker, new Date());
  const mine = result.status === "processed" ? result.commands.find((c) => c.id === command.id) : undefined;
  if (!mine) {
    console.log(`Queued ${kind} (${command.id}) for ${env}; the next tick processes it.`);
    return;
  }
  console.log(mine.outcome.status === "accepted" ? `${kind} accepted for ${env}.` : `${kind} REJECTED for ${env}: ${mine.outcome.reason}`);
  if (result.status === "processed") console.log(JSON.stringify(result.withdrawal, null, 2));
});
