import { asc, ne, or, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { capitalFlows, strategies } from "../db/schema.js";
import type { TimelineTransfer, TimelineVersion } from "./driver.js";

/**
 * Trader's own history as a replay timeline (#57 T4): every strategy version
 * as it was stored, and every transfer that counted. Read with SELECTs only,
 * and kept in git-ignored .cache/replay/ (it holds live figures).
 */

export interface Timeline {
  env: string;
  exportedAt: string;
  versions: TimelineVersion[];
  transfers: TimelineTransfer[];
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
  const t = JSON.parse(json) as Timeline & { versions: (TimelineVersion & { at: string })[]; transfers: (TimelineTransfer & { at: string })[] };
  return {
    ...t,
    versions: t.versions.map((v) => ({ ...v, at: new Date(v.at) })),
    transfers: t.transfers.map((x) => ({ ...x, at: new Date(x.at) })),
  };
}
