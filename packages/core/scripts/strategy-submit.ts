/**
 * OWNER: submit a strategy document (JSON) as the next version. It's
 * validated exactly as Claude's will be; a rejection is audited and emailed,
 * and the active version stays.
 *
 *   npm run strategy:submit -w @trader/core -- --env staging --file strategy.json
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { submitStrategy } from "../src/portfolio/store.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, file: { type: "string" } } });
if (!values.file) throw new Error("--file <strategy.json> is required");
const doc = JSON.parse(readFileSync(values.file, "utf8")) as unknown;

await withOps(values.env, async ({ env, db }) => {
  const result = await submitStrategy(db, doc, "owner", new Date());
  if (result.status === "activated") console.log(`✓ ${env}: strategy v${result.version} is active from the next rebalance step.`);
  else {
    console.error(`✗ ${env}: rejected. The active version is unchanged.`);
    for (const e of result.errors) console.error(`  • ${e}`);
    process.exit(1);
  }
});
