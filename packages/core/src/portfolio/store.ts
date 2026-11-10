import { desc, eq, inArray, ne } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { Db } from "../db/client.js";
import { strategies, thesisEvents } from "../db/schema.js";
import { add } from "../money.js";
import { marketDate } from "../time.js";
import { EXIT_RULES, type ExitRules, type Strategy, VERSION_0, validateStrategy } from "./strategy.js";
import { CLOSING_KINDS, reviewDateErrors } from "./theses.js";

export interface ActiveStrategy {
  version: number;
  authoredBy: "claude" | "owner" | "system";
  createdAt: Date;
  /**
   * When its theses were last reaffirmed: the latest version Claude or the
   * owner wrote. A system version (withdrawal fallback funding) only copies
   * the theses it replaces, so it doesn't reset their staleness (SPEC-capital).
   */
  reaffirmedAt: Date;
  strategy: Strategy;
}

/**
 * The highest stored version, or version 0 (hold VTI) if nothing has been
 * accepted yet. Stored documents were validated on the way in; they're
 * re-validated here so a bad row fails closed (falls back to version 0) and is logged.
 */
export async function activeStrategy(db: Db, now: Date): Promise<ActiveStrategy> {
  const [row] = await db.select().from(strategies).orderBy(desc(strategies.version)).limit(1);
  if (!row) return { version: 0, authoredBy: "system", createdAt: now, reaffirmedAt: now, strategy: VERSION_0 };
  const parsed = validateStrategy(row.document);
  if (!parsed.ok) {
    console.error(JSON.stringify({ level: "error", message: "stored strategy failed validation; using version 0", version: row.version, errors: parsed.errors }));
    return { version: 0, authoredBy: "system", createdAt: now, reaffirmedAt: now, strategy: VERSION_0 };
  }
  let reaffirmedAt = row.createdAt;
  if (row.authoredBy === "system") {
    const [authored] = await db
      .select({ createdAt: strategies.createdAt })
      .from(strategies)
      .where(ne(strategies.authoredBy, "system"))
      .orderBy(desc(strategies.version))
      .limit(1);
    if (authored) reaffirmedAt = authored.createdAt;
  }
  return { version: row.version, authoredBy: row.authoredBy, createdAt: row.createdAt, reaffirmedAt, strategy: parsed.strategy };
}

/** Thesis ids closed for good: stopped out, or (#35) trailing-stopped or sold at their profit target. */
export async function stoppedThesisIds(db: Db): Promise<Set<string>> {
  const rows = await db.select({ id: thesisEvents.thesisId }).from(thesisEvents).where(inArray(thesisEvents.kind, CLOSING_KINDS));
  return new Set(rows.map((r) => r.id));
}

export type SubmitStrategyResult = { status: "activated"; version: number } | { status: "rejected"; errors: string[] };

/**
 * Validate and store a new strategy version (SPEC-portfolio). `actor` is
 * `claude` (via `agent`'s submit_strategy), `owner` (strategy:submit), or
 * `system` (a withdrawal's fallback funding, SPEC-capital).
 * A rejection is audited (urgent email) and leaves the active version alone.
 */
/**
 * What a valid document must also meet against the stored history: no
 * stopped thesis id reused, and the review-date rules. preview_strategy and
 * submitStrategy both check it, so a preview never passes what submit rejects.
 */
export async function submissionErrors(db: Db, s: Strategy, now: Date, rules: ExitRules = EXIT_RULES): Promise<string[]> {
  const stopped = await stoppedThesisIds(db);
  const errors = s.conviction.flatMap((t, i) => [
    ...(stopped.has(t.id) ? [`conviction[${i}].id: "${t.id}" was stopped out; re-entering needs a new thesis id`] : []),
    ...(t.trailingStopPct !== undefined && !rules.trailingStop ? [`conviction[${i}].trailingStopPct: trailing stops aren't switched on; leave it out`] : []),
    ...(t.takeProfitPct !== undefined && !rules.takeProfit ? [`conviction[${i}].takeProfitPct: profit targets aren't switched on; leave it out`] : []),
  ]);
  const active = await activeStrategy(db, now);
  return [...errors, ...reviewDateErrors(s, active.strategy, marketDate(now))];
}

export async function submitStrategy(db: Db, doc: unknown, actor: "claude" | "owner" | "system", now: Date): Promise<SubmitStrategyResult> {
  const parsed = validateStrategy(doc);
  const errors = parsed.ok ? await submissionErrors(db, parsed.strategy, now) : parsed.errors;
  if (!parsed.ok || errors.length > 0) {
    const active = await activeStrategy(db, now);
    await recordEvent(db, { actor, kind: "strategy.rejected", payload: { authoredBy: actor, errors, activeVersion: active.version } });
    return { status: "rejected", errors };
  }

  const s = parsed.strategy;
  const [row] = await db
    .insert(strategies)
    .values({ authoredBy: actor, summary: s.summary, document: s as unknown as Record<string, unknown>, createdAt: now })
    .returning({ version: strategies.version });
  if (!row) throw new Error("strategies insert returned no row");
  await recordEvent(db, {
    actor,
    kind: "strategy.activated",
    subject: `v${row.version}`,
    payload: {
      version: row.version,
      authoredBy: actor,
      summary: s.summary,
      theses: s.conviction.length,
      convictionPct: s.conviction.reduce((sum, t) => add(sum, t.targetWeightPct), "0"),
      plain: s.conviction.filter((t) => t.plainSummary).map((t) => ({ symbol: t.symbol, targetWeightPct: t.targetWeightPct, text: t.plainSummary })),
      topN: s.systematic.topN,
      universeSize: s.systematic.universe.length,
    },
  });
  return { status: "activated", version: row.version };
}
