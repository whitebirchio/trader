/**
 * Print what would be emailed, sending nothing: the pending urgent events, or
 * (with --digest) today's digest as it stands now.
 *
 *   npm run notify:preview -w @trader/core -- --env staging|production [--digest]
 *   npm run notify:preview -w @trader/core -- --sample withdrawal   (sample emails; no database)
 */
import { parseArgs } from "node:util";
import { and, gte, inArray } from "drizzle-orm";
import { auditEvents } from "../src/db/schema.js";
import { composeDigest, composeUrgent } from "../src/notifications/compose.js";
import { coveredEventIds } from "../src/notifications/outbox.js";
import { DIGEST_KINDS, URGENT_KINDS } from "../src/notifications/routing.js";
import { loadSnapshot } from "../src/risk/gate.js";
import { LIMITS } from "../src/risk/limits.js";
import { marketDate } from "../src/time.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, digest: { type: "boolean" }, sample: { type: "string" } } });

if (values.sample) {
  if (values.sample !== "withdrawal") throw new Error("--sample withdrawal is the only sample");
  for (const email of withdrawalSamples()) console.log(`SUBJECT: ${email.subject}\n\n${email.text}\n\n${"-".repeat(72)}\n`);
  process.exit(0);
}

await withOps(values.env, async ({ env, db, broker }) => {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const kinds = values.digest ? DIGEST_KINDS : URGENT_KINDS;
  const events = await db.select().from(auditEvents).where(and(inArray(auditEvents.kind, kinds), gte(auditEvents.at, since))).orderBy(auditEvents.at);
  const toN = (e: (typeof events)[number]) => ({ kind: e.kind, subject: e.subject, payload: e.payload, at: e.at });

  if (values.digest) {
    const today = marketDate(now);
    const s = await loadSnapshot(db, broker, [], now, LIMITS);
    const email = composeDigest(
      {
        date: today,
        equity: s.equity,
        cash: s.cash,
        dailyChangePct: s.index.dailyChangePct,
        drawdownPct: s.index.drawdownPct,
        positions: s.holdings.map((h) => ({ symbol: h.symbol, qty: h.qty, marketValue: h.marketValue })),
        events: events.filter((e) => marketDate(e.at) === today).map(toN),
        state: { killSwitch: s.state.killSwitch, halted: s.state.halted, haltReason: s.state.haltReason },
      },
      env,
    );
    console.log(`SUBJECT: ${email.subject}\n\n${email.text}`);
    return;
  }

  const covered = await coveredEventIds(db, "urgent", events.map((e) => e.id));
  const pending = events.filter((e) => !covered.has(e.id));
  if (pending.length === 0) return console.log(`No un-emailed urgent events on ${env}.`);
  const email = composeUrgent(pending.map(toN), env);
  console.log(`SUBJECT: ${email.subject}\n\n${email.text}`);
});

/** A withdrawal's emails, end to end, with made-up numbers: the wording without a real request. */
function withdrawalSamples() {
  const at = new Date("2026-11-02T15:05:00Z");
  const ev = (kind: string, payload: Record<string, unknown>, minutes = 0) => ({ kind, subject: "w-sample", payload, at: new Date(at.getTime() + minutes * 60_000) });
  const deadline = "2026-11-02T18:00:00.000Z";
  return [
    composeUrgent([ev("capital.withdrawal_requested", { amount: "500", requestedBy: "dashboard:owner", deadline })], "production", at),
    composeUrgent(
      [
        ev("strategy.activated", { version: 8, authoredBy: "claude", summary: "Funding the $500 withdrawal from VTI and the weakest momentum pick; theses kept whole.", theses: 3, convictionPct: "45", topN: 3, universeSize: 40 }, 70),
        ev("capital.funding_planned", { amount: "500", reason: "strategy v8 (claude) plans the sells", summary: "Funding the $500 withdrawal from VTI and the weakest momentum pick; theses kept whole." }, 70),
      ],
      "production",
      at,
    ),
    composeUrgent([ev("capital.withdrawal_ready", { amount: "500", outstanding: "500", withdrawable: "500", reason: "$503.12 of settled cash covers $500.00" }, 1500)], "production", at),
    composeUrgent([ev("capital.command_rejected", { kind: "request", requestedBy: "dashboard:owner", reason: "a withdrawal is already open ($500, ready); cancel it first" })], "production", at),
    composeDigest(
      {
        date: "2026-11-02",
        equity: "1004.20",
        cash: "503.12",
        dailyChangePct: "0.12",
        drawdownPct: "0",
        positions: [{ symbol: "VTI", qty: "1.667", marketValue: "501.08" }],
        events: [ev("capital.withdrawal_settling", { reason: "$503.12 of cash covers $500.00; should settle by Tue, Nov 3, 4:00 PM ET" }, 200)],
        state: { killSwitch: false, halted: false, haltReason: null },
        capital: { since: "2026-10-30", startValue: "1000", addedSince: "0", value: "1004.20", sameFlowsInVti: "1003.10" },
        withdrawal: { status: "settling", amount: "500", outstanding: "500", unfunded: "0", planBy: null },
      },
      "production",
      at,
    ),
  ];
}
