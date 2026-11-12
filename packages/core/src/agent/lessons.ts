import { desc } from "drizzle-orm";
import { z } from "zod";
import { recordEvent } from "../audit.js";
import type { Db } from "../db/client.js";
import { strategies, thesisLessons } from "../db/schema.js";
import { type ScorecardRow, loadScorecard } from "../portfolio/scorecard.js";

/**
 * Exit post-mortems (#28, SPEC-agent § Lessons). The scorecard says whether a
 * thesis beat VTI, not why, and each run starts cold. Once a thesis is closed
 * (flat after it left the strategy), the next run writes what it expected,
 * what happened and what it would do differently, and later runs read it
 * before deciding on the same stock or the same kind of signal. Insert-only:
 * a thesis's latest row is its lesson. It has no trading effect.
 */

export const LESSON_LIMITS = { perCall: 10, minChars: 20, maxChars: 600, perSymbol: 3 } as const;

const text = (what: string) =>
  z.string().trim().min(LESSON_LIMITS.minChars, `say ${what} in a sentence or two`).max(LESSON_LIMITS.maxChars, `keep it to ${LESSON_LIMITS.maxChars} characters`);

const entry = z.object({
  thesisId: z.string().trim().min(1, "name the thesis id"),
  expected: text("what the thesis expected"),
  happened: text("what happened"),
  lesson: text("what to do differently"),
});
export type LessonInput = z.infer<typeof entry>;

export interface Lesson {
  thesisId: string;
  symbol: string;
  primaryKind: string | null;
  ending: string;
  expected: string;
  happened: string;
  lesson: string;
  /** The outcome it was judged against, as the scorecard had it then. */
  outcome: LessonOutcome;
  at: string;
}

export interface LessonOutcome {
  daysHeld: number;
  closedAt: string | null;
  /** Null when the row couldn't be scored. */
  returnPct: string | null;
  vtiPct: string | null;
  excessPct: string | null;
}

const outcomeOf = (r: ScorecardRow): LessonOutcome => ({
  daysHeld: r.daysHeld,
  closedAt: r.closedAt?.toISOString() ?? null,
  returnPct: r.money?.returnPct ?? null,
  vtiPct: r.money?.vtiPct ?? null,
  excessPct: r.money?.excessPct ?? null,
});

/** The latest lesson for each thesis id, newest first. */
export async function latestLessons(db: Db): Promise<Lesson[]> {
  const rows = await db.select().from(thesisLessons).orderBy(desc(thesisLessons.at));
  const seen = new Set<string>();
  const out: Lesson[] = [];
  for (const r of rows) {
    if (seen.has(r.thesisId)) continue;
    seen.add(r.thesisId);
    out.push({
      thesisId: r.thesisId,
      symbol: r.symbol,
      primaryKind: r.primaryKind,
      ending: r.ending,
      expected: r.expected,
      happened: r.happened,
      lesson: r.lesson,
      outcome: r.outcome as unknown as LessonOutcome,
      at: r.at.toISOString(),
    });
  }
  return out;
}

/** A scorecard row's lesson: the newest written on any of its ids. */
export function lessonFor(row: Pick<ScorecardRow, "ids">, lessons: Lesson[]): Lesson | null {
  return lessons.find((l) => row.ids.includes(l.thesisId)) ?? null;
}

/** Closed rows (flat after the thesis left) without a lesson, newest close first. */
export function rowsDueLessons(rows: ScorecardRow[], lessons: Lesson[]): ScorecardRow[] {
  return rows.filter((r) => r.closedAt && !lessonFor(r, lessons)).sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime());
}

/** The last strategy version listing each of the given thesis ids, for get_strategy. */
export async function lastListedVersions(db: Db, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const want = new Set(ids);
  const versions = await db.select({ version: strategies.version, document: strategies.document }).from(strategies).orderBy(desc(strategies.version));
  for (const v of versions) {
    // Read leniently, as the scorecard does: an old document may not match today's schema.
    const conviction = (v.document as { conviction?: unknown }).conviction;
    if (!Array.isArray(conviction)) continue;
    for (const t of conviction) {
      const id = (t as { id?: unknown })?.id;
      if (typeof id === "string" && want.has(id) && !out.has(id)) out.set(id, v.version);
    }
    if (out.size === want.size) break;
  }
  return out;
}

export type RecordLessonsResult = { status: "recorded"; recorded: { thesisId: string; symbol: string; replaced: boolean }[]; stillDue: number } | { status: "rejected"; errors: string[] };

/**
 * Record a batch of post-mortems, all or nothing. Each names a thesis id from
 * a closed scorecard row (flat after the thesis left); one still active or
 * still holding shares, an unknown id, or the same row twice is refused. The
 * outcome is frozen from the scorecard now. A later lesson on a thesis
 * replaces its earlier one. One audit event per batch, which the digest reports.
 */
export async function recordLessons(db: Db, input: unknown, actor: "claude" | "owner", now: Date): Promise<RecordLessonsResult> {
  const parsed = z.array(entry).min(1, "needs at least one lesson").max(LESSON_LIMITS.perCall, `at most ${LESSON_LIMITS.perCall} lessons at a time`).safeParse(input);
  if (!parsed.success) return { status: "rejected", errors: parsed.error.issues.map((i) => `${i.path.length ? `lessons.${i.path.join(".")}: ` : ""}${i.message}`) };
  const lessons = parsed.data;

  const card = await loadScorecard(db, now);
  const errors: string[] = [];
  const matched: ScorecardRow[] = [];
  lessons.forEach((l, i) => {
    const row = card.theses.find((r) => r.ids.includes(l.thesisId));
    if (!row) return errors.push(`lessons[${i}].thesisId: "${l.thesisId}" isn't in the track record`);
    if (!row.leftAt) return errors.push(`lessons[${i}].thesisId: "${l.thesisId}" is still in the strategy; a lesson waits until it closes`);
    if (!row.closedAt) return errors.push(`lessons[${i}].thesisId: "${l.thesisId}" left the strategy but its shares aren't all sold yet`);
    if (matched.includes(row)) return errors.push(`lessons[${i}].thesisId: "${l.thesisId}" is the same thesis as an earlier lesson in this batch`);
    matched.push(row);
  });
  if (errors.length) return { status: "rejected", errors };

  const before = await latestLessons(db);
  const recorded = lessons.map((l, i) => ({ thesisId: l.thesisId, symbol: matched[i]!.symbol, replaced: lessonFor(matched[i]!, before) !== null }));
  await db.insert(thesisLessons).values(
    lessons.map((l, i) => {
      const row = matched[i]!;
      return {
        thesisId: l.thesisId,
        symbol: row.symbol,
        primaryKind: row.primaryKind,
        ending: row.ending,
        expected: l.expected,
        happened: l.happened,
        lesson: l.lesson,
        outcome: outcomeOf(row) as unknown as Record<string, unknown>,
        actor,
        at: now,
      };
    }),
  );
  await recordEvent(db, {
    actor,
    kind: "lessons.recorded",
    subject: recorded.map((r) => r.symbol).join(", "),
    payload: {
      lessons: lessons.map((l, i) => ({ thesisId: l.thesisId, symbol: matched[i]!.symbol, ending: matched[i]!.ending, excessPct: matched[i]!.money?.excessPct ?? null, lesson: l.lesson, replaced: recorded[i]!.replaced })),
    },
  });
  const stillDue = rowsDueLessons(card.theses, await latestLessons(db)).length;
  return { status: "recorded", recorded, stillDue };
}
