/**
 * OWNER: turn the kill switch on. Every order is rejected, sells included,
 * until `risk:resume`.
 *
 *   npm run risk:kill -w @trader/core -- --env production|paper --reason "…"
 */
import { parseArgs } from "node:util";
import { setKillSwitch } from "../src/risk/state.js";
import { requireReason, withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, reason: { type: "string" } } });
const reason = requireReason(values.reason);

await withOps(values.env, async ({ env, db }) => {
  const result = await setKillSwitch(db, { actor: "owner", reason }, new Date());
  console.log(result.status === "on" ? `Kill switch ON for ${env}: ${reason}` : `Kill switch was already on for ${env}.`);
});
