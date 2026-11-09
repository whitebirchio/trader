/**
 * Fetch (or reuse) the replay's market data for some symbols and a range, and
 * report what's there (#57 T3). Market data only, with the PAPER key from
 * .env (STAGING_ALPACA_*), cached under packages/core/.cache/replay/.
 *
 *   npm run replay:data -w @trader/core -- --symbols VTI,AAPL --from 2025-11-03 --to 2026-11-06
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import { MarketDataOnly } from "../src/broker/market-data.js";
import { loadMarket } from "../src/replay/data.js";
import { readRepoEnv } from "./repo-env.js";

export const REPLAY_CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "replay");

/** Market data through the paper hosts with the paper key: no account access, in any environment. */
export function paperMarketData(): MarketDataOnly {
  const env = readRepoEnv();
  return new MarketDataOnly(new AlpacaBroker({ env: "staging", keyId: env.require("STAGING_ALPACA_KEY_ID"), secretKey: env.require("STAGING_ALPACA_SECRET_KEY"), timeoutMs: 60_000 }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { symbols: { type: "string" }, from: { type: "string" }, to: { type: "string" } } });
  if (!values.symbols || !values.from || !values.to) throw new Error("--symbols A,B --from YYYY-MM-DD --to YYYY-MM-DD are required");
  const started = Date.now();
  const { market, missing } = await loadMarket(values.symbols.split(","), values.from, values.to, {
    dir: REPLAY_CACHE,
    source: paperMarketData(),
    log: (m) => console.error(m),
  });
  for (const [symbol, bars] of Object.entries(market.bars)) {
    console.log(`${symbol.padEnd(6)} ${String(bars.length).padStart(4)} bars  ${bars[0]?.t.toISOString().slice(0, 10) ?? "-"} → ${bars.at(-1)?.t.toISOString().slice(0, 10) ?? "-"}  last close ${bars.at(-1)?.c ?? "-"}`);
  }
  console.log(`calendar: ${market.calendar.length} sessions; missing bars: ${missing.bars.join(", ") || "none"}; missing assets: ${missing.assets.join(", ") || "none"}; ${Date.now() - started} ms`);
}
