/**
 * Export an environment's history as a replay timeline (#57 T4): its strategy
 * versions as stored and its transfers, read with SELECTs only, into
 * git-ignored packages/core/.cache/replay/timeline-<env>.json. It holds live
 * figures, so it stays local. Prints counts and dates only.
 *
 *   npm run replay:export -w @trader/core -- --env production|paper
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { exportTimeline, serializeTimeline } from "../src/replay/timeline.js";
import { withOps } from "./ops.js";
import { REPLAY_CACHE } from "./replay-data.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });
await withOps(values.env, async ({ env, db }) => {
  const timeline = await exportTimeline(db, env, new Date());
  mkdirSync(REPLAY_CACHE, { recursive: true });
  const file = join(REPLAY_CACHE, `timeline-${env}.json`);
  writeFileSync(file, serializeTimeline(timeline));
  const span = (dates: Date[]) => (dates.length ? `${dates[0]!.toISOString().slice(0, 10)} → ${dates.at(-1)!.toISOString().slice(0, 10)}` : "none");
  console.log(`${env}: ${timeline.versions.length} strategy versions (${span(timeline.versions.map((v) => v.at))}), ${timeline.transfers.length} transfers (${span(timeline.transfers.map((t) => t.at))}) → ${file}`);
});
