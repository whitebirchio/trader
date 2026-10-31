/**
 * Print what would be emailed, sending nothing: the pending urgent events, or
 * (with --digest) today's digest as it stands now.
 *
 *   npm run notify:preview -w @trader/core -- --env staging|production [--digest]
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

const { values } = parseArgs({ options: { env: { type: "string" }, digest: { type: "boolean" } } });

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
