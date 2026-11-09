/**
 * Replay a timeline through the real jobs and report on it (#57 T5): an
 * exported history (`replay:export`) or a timeline file, over cached market
 * data (`replay:data` fetches what's missing, with the paper key). Prints the
 * report and writes it, as text and JSON, to git-ignored
 * packages/core/.cache/replay/reports/. A history's report holds live
 * figures, so it stays local.
 *
 *   npm run replay -w @trader/core -- --timeline staging|production|<file> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--slippage-bps 10] [--compare-actual]
 *
 * --compare-actual adds the fidelity check (T6): the replay set against what
 * the account actually did, from the timeline's `actual` (exported since T6),
 * written alongside as <name>-fidelity.txt.
 *
 * --from defaults to the timeline's first version, --to to yesterday (the
 * last session whose bars are complete).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { loadMarket } from "../src/replay/data.js";
import { replay } from "../src/replay/driver.js";
import { compareFidelity, formatFidelity } from "../src/replay/fidelity.js";
import { formatReport, replayReport } from "../src/replay/report.js";
import { parseTimeline, readAccountHistory, timelineStart, timelineSymbols } from "../src/replay/timeline.js";
import { marketDate } from "../src/time.js";
import { REPLAY_CACHE, paperMarketData } from "./replay-data.js";

const { values } = parseArgs({ options: { timeline: { type: "string" }, from: { type: "string" }, to: { type: "string" }, "slippage-bps": { type: "string" }, "compare-actual": { type: "boolean" } } });
if (!values.timeline) throw new Error("--timeline staging|production|<file> is required");
const file = values.timeline === "staging" || values.timeline === "production" ? join(REPLAY_CACHE, `timeline-${values.timeline}.json`) : values.timeline;
const timeline = parseTimeline(readFileSync(file, "utf8"));
if (values["compare-actual"] && !timeline.actual) throw new Error(`${file} has no actual history (exported before T6): run replay:export again`);
const from = values.from ?? timelineStart(timeline);
if (!from) throw new Error(`${file} has no strategy versions; pass --from`);
const to = values.to ?? marketDate(new Date(Date.now() - 86_400_000));
const slippageBps = values["slippage-bps"] === undefined ? 10 : Number(values["slippage-bps"]);
if (!Number.isInteger(slippageBps) || slippageBps < 0) throw new Error("--slippage-bps must be a whole number of basis points");

const { market, missing } = await loadMarket(timelineSymbols(timeline), from, to, { dir: REPLAY_CACHE, source: paperMarketData(), log: (m) => console.error(m) });
if (missing.bars.length || missing.assets.length) console.error(`missing bars: ${missing.bars.join(", ") || "none"}; missing assets: ${missing.assets.join(", ") || "none"}`);

const result = await replay({ market, versions: timeline.versions, transfers: timeline.transfers, from, to, slippageBps });
const report = await replayReport(result, { from, to, slippageBps });
const text = formatReport(report);
const sessions = market.calendar.filter((d) => d.date >= from && d.date <= to).map((d) => d.date);
const fidelity = values["compare-actual"] ? formatFidelity(compareFidelity({ live: timeline.actual!, replay: await readAccountHistory(result.db), flows: timeline.transfers, sessions })) : null;
await result.pglite.close();

const dir = join(REPLAY_CACHE, "reports");
mkdirSync(dir, { recursive: true });
const name = `${basename(file, ".json").replace(/^timeline-/, "")}-${from}-${to}-${slippageBps}bps`;
writeFileSync(join(dir, `${name}.txt`), text);
writeFileSync(join(dir, `${name}.json`), JSON.stringify(report, null, 2));
console.log(text);
console.log(`→ ${join(dir, `${name}.txt`)} (and .json)`);
if (fidelity) {
  writeFileSync(join(dir, `${name}-fidelity.txt`), fidelity);
  console.log(`\n${fidelity}`);
  console.log(`→ ${join(dir, `${name}-fidelity.txt`)}`);
}
