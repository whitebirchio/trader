/**
 * Dry run: evaluate proposals against the environment's current state and
 * print the decisions. Records nothing and places nothing.
 *
 *   npm run risk:check -w @trader/core -- --env paper --buy VTI=50 --buy AAPL=300:conviction --sell VTI=0.1 [--sync]
 *
 * --sync runs a broker sync first (ignoring market hours) so the data is fresh.
 */
import { parseArgs } from "node:util";
import { syncBroker } from "../src/broker/sync.js";
import { loadSnapshot } from "../src/risk/gate.js";
import { LIMITS } from "../src/risk/limits.js";
import { evaluateOrders } from "../src/risk/rules.js";
import type { Proposal, Sleeve } from "../src/risk/types.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({
  options: {
    env: { type: "string" },
    buy: { type: "string", multiple: true },
    sell: { type: "string", multiple: true },
    sync: { type: "boolean" },
  },
});

function parse(spec: string, side: "buy" | "sell"): Proposal {
  const m = /^([A-Z][A-Z0-9.]*)=([0-9.]+)(?::(systematic|conviction))?$/.exec(spec);
  if (!m) throw new Error(`bad --${side} ${spec} (expected SYMBOL=AMOUNT[:systematic|conviction])`);
  const [, symbol, amount, sleeve] = m as unknown as [string, string, string, Sleeve | undefined];
  const base = { key: `check:${symbol}:${side}`, symbol, sleeve: sleeve ?? "systematic" } as const;
  return side === "buy" ? { ...base, side, notional: amount } : { ...base, side, qty: amount };
}

const proposals = [...(values.buy ?? []).map((b) => parse(b, "buy")), ...(values.sell ?? []).map((s) => parse(s, "sell"))];
if (proposals.length === 0) throw new Error("give at least one --buy or --sell");

await withOps(values.env, async ({ env, db, broker }) => {
  const now = new Date();
  if (values.sync) await syncBroker(db, broker, env, now, { ignoreSession: true });
  const snapshot = await loadSnapshot(db, broker, proposals, now, LIMITS);
  console.log(`Dry run on ${env}: equity $${snapshot.equity}, cash $${snapshot.cash}, drawdown ${snapshot.index.drawdownPct}%, today ${snapshot.index.dailyChangePct}%`);
  for (const d of evaluateOrders(snapshot, proposals, LIMITS)) {
    const p = d.proposal;
    const asked = p.side === "buy" ? `$${p.notional}` : `${p.qty} sh`;
    const got = d.notional ? `$${d.notional}` : d.qty ? `${d.qty} sh` : "—";
    console.log(`  ${p.side.padEnd(4)} ${p.symbol.padEnd(5)} ${asked.padStart(8)} [${p.sleeve}] → ${d.verdict.toUpperCase()} ${got}`);
    for (const r of d.reasons) console.log(`      ${r}`);
  }
});
