/**
 * OWNER: clear the kill switch and/or the drawdown halt.
 *
 *   npm run risk:resume -w @trader/core -- --env staging|production --reason "…"
 */
import { parseArgs } from "node:util";
import { resume } from "../src/risk/state.js";
import { requireReason, withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, reason: { type: "string" } } });
const reason = requireReason(values.reason);

await withOps(values.env, async ({ env, db }) => {
  const result = await resume(db, { actor: "owner", reason }, new Date());
  if (result.status === "nothing_to_resume") console.log(`Nothing to resume for ${env}: no kill switch or halt is set.`);
  else console.log(`Resumed ${env}. Cleared: ${result.cleared.join(", ")}.`);
});
