/**
 * Record Alpaca PAPER responses as test fixtures, scrubbed of identifiers.
 *
 *   npm run broker:capture -w @trader/core
 *
 * Reads STAGING_ALPACA_KEY_ID / STAGING_ALPACA_SECRET_KEY from the repo .env.
 * Paper only: there is no flag to point it at the live account.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alpacaHosts } from "../src/broker/hosts.js";
import { readRepoEnv } from "./repo-env.js";

const env = readRepoEnv();
const headers = {
  "APCA-API-KEY-ID": env.require("STAGING_ALPACA_KEY_ID"),
  "APCA-API-SECRET-KEY": env.require("STAGING_ALPACA_SECRET_KEY"),
};
const { trading, data } = alpacaHosts("staging");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "broker", "fixtures");
mkdirSync(out, { recursive: true });

// Identifiers are replaced with stable placeholders, so fixtures diff cleanly
// between captures and never carry the real account number.
const SCRUB = new Set(["id", "account_number", "asset_id", "order_id", "client_order_id", "replaced_by", "replaces"]);
const seen = new Map<string, string>();
function scrub(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (!SCRUB.has(key) || typeof v !== "string") return v;
      if (!seen.has(v)) seen.set(v, `${key}-${seen.size + 1}`);
      return seen.get(v);
    }),
  );
}

const end = new Date(Date.now() - 16 * 60_000).toISOString();
const captures: Record<string, string> = {
  account: `${trading}/v2/account`,
  configurations: `${trading}/v2/account/configurations`,
  clock: `${trading}/v2/clock`,
  calendar: `${trading}/v2/calendar?start=2026-10-30&end=2026-11-03`,
  positions: `${trading}/v2/positions`,
  orders: `${trading}/v2/orders?status=all&direction=asc&limit=50`,
  activities: `${trading}/v2/account/activities?direction=asc&page_size=50`,
  "asset-VTI": `${trading}/v2/assets/VTI`,
  bars: `${data}/v2/stocks/bars?symbols=VTI,SPY&timeframe=1Day&start=2026-10-26T00:00:00Z&end=${end}&adjustment=all&feed=sip&limit=10`,
};

for (const [name, url] of Object.entries(captures)) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(scrub(await res.json()), null, 2)}\n`);
  console.log(`captured ${name}`);
}
