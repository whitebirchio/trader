import { and, asc, eq, isNotNull, ne, or, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brokerActivities, capitalFlows, equitySnapshots, strategies, thesisEvents } from "../db/schema.js";
import type { TimelineTransfer, TimelineVersion } from "./driver.js";

/**
 * Trader's own history as a replay timeline (#57 T4): every strategy version
 * as it was stored, and every transfer that counted. Read with SELECTs only,
 * and kept in git-ignored .cache/replay/ (it holds live figures). With it,
 * what actually happened (fills, equity snapshots, thesis events), for the
 * fidelity check (T6) to compare a replay against.
 */

/** What an account did: read the same way from the live database and from a replay's. */
export interface AccountHistory {
  fills: { at: Date; symbol: string; side: string; qty: string; price: string }[];
  snapshots: { tradingDate: string; equity: string; recordedAt: Date }[];
  thesisEvents: { at: Date; thesisId: string; symbol: string; kind: string }[];
}

export interface Timeline {
  env: string;
  exportedAt: string;
  versions: TimelineVersion[];
  transfers: TimelineTransfer[];
  /** Absent in timelines exported before T6. */
  actual?: AccountHistory;
}

export async function readAccountHistory(db: Db): Promise<AccountHistory> {
  const [fills, snapshots, events] = await Promise.all([
    db
      .select({ at: brokerActivities.at, symbol: brokerActivities.symbol, side: brokerActivities.side, qty: brokerActivities.qty, price: brokerActivities.price })
      .from(brokerActivities)
      .where(and(eq(brokerActivities.type, "FILL"), isNotNull(brokerActivities.symbol), isNotNull(brokerActivities.qty), isNotNull(brokerActivities.price)))
      .orderBy(asc(brokerActivities.at), asc(brokerActivities.id)),
    db.select({ tradingDate: equitySnapshots.tradingDate, equity: equitySnapshots.equity, recordedAt: equitySnapshots.recordedAt }).from(equitySnapshots).orderBy(asc(equitySnapshots.tradingDate)),
    db.select({ at: thesisEvents.at, thesisId: thesisEvents.thesisId, symbol: thesisEvents.symbol, kind: thesisEvents.kind }).from(thesisEvents).orderBy(asc(thesisEvents.at)),
  ]);
  return {
    fills: fills.map((f) => ({ at: f.at, symbol: f.symbol!, side: f.side ?? "", qty: f.qty!, price: f.price! })),
    snapshots,
    thesisEvents: events,
  };
}

export async function exportTimeline(db: Db, env: string, now: Date): Promise<Timeline> {
  const versions = await db.select().from(strategies).orderBy(asc(strategies.version));
  // Canceled transfers are left out of performance (SPEC-capital), so out of the replay too.
  const flows = await db
    .select({ at: capitalFlows.at, amount: capitalFlows.amount })
    .from(capitalFlows)
    .where(or(isNull(capitalFlows.status), ne(capitalFlows.status, "canceled")))
    .orderBy(asc(capitalFlows.at));
  return {
    env,
    exportedAt: now.toISOString(),
    versions: versions.map((v) => ({ at: v.createdAt, authoredBy: v.authoredBy, document: v.document, version: v.version, raw: true })),
    transfers: flows.map((f) => ({ at: f.at, amount: f.amount })),
    actual: await readAccountHistory(db),
  };
}

/**
 * Every symbol a timeline can trade: thesis symbols, systematic universes and
 * defensives, and VTI (the benchmark and idle default). Documents are read
 * leniently, like the scorecard reads them.
 */
export function timelineSymbols(t: Pick<Timeline, "versions">): string[] {
  const symbols = new Set<string>(["VTI"]);
  for (const v of t.versions) {
    const d = v.document as { conviction?: { symbol?: unknown }[]; systematic?: { universe?: unknown[]; defensive?: unknown } } | null;
    for (const c of Array.isArray(d?.conviction) ? d!.conviction : []) if (typeof c?.symbol === "string") symbols.add(c.symbol);
    for (const s of Array.isArray(d?.systematic?.universe) ? d!.systematic!.universe! : []) if (typeof s === "string") symbols.add(s);
    if (typeof d?.systematic?.defensive === "string") symbols.add(d.systematic.defensive);
  }
  return [...symbols].sort();
}

/** The date of the first strategy version: where a recorded history's replay starts (earlier deposits apply that day). */
export function timelineStart(t: Pick<Timeline, "versions">): string | null {
  const first = [...t.versions].sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  return first ? first.at.toISOString().slice(0, 10) : null;
}

export function serializeTimeline(t: Timeline): string {
  return JSON.stringify(t, null, 1);
}

/** A timeline from its JSON, with dates revived. */
export function parseTimeline(json: string): Timeline {
  const t = JSON.parse(json) as Timeline;
  const at = <T extends { at: Date }>(x: T): T => ({ ...x, at: new Date(x.at) });
  return {
    ...t,
    versions: t.versions.map(at),
    transfers: t.transfers.map(at),
    actual: t.actual && {
      fills: t.actual.fills.map(at),
      snapshots: t.actual.snapshots.map((s) => ({ ...s, recordedAt: new Date(s.recordedAt) })),
      thesisEvents: t.actual.thesisEvents.map(at),
    },
  };
}
