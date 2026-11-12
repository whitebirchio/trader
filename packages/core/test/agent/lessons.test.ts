import { beforeEach, describe, expect, it } from "vitest";
import { LESSON_LIMITS, lastListedVersions, latestLessons, lessonFor, recordLessons, rowsDueLessons } from "../../src/agent/lessons.js";
import { checkEligibility, getTrackRecord, recordLessonTool } from "../../src/agent/tools.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, benchmarkCloses, brokerActivities, positions, strategies, thesisLessons } from "../../src/db/schema.js";
import type { ScorecardRow } from "../../src/portfolio/scorecard.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-06T21:00:00Z");

const AAPL = thesis({ id: "aapl-a", symbol: "AAPL" });
const MSFT = thesis({ id: "msft-a", symbol: "MSFT", evidence: [{ kind: "insider", summary: "CEO bought" }] });
const NVDA = thesis({ id: "nvda-a", symbol: "NVDA" });

const lesson = (thesisId: string, extra: Partial<Record<"expected" | "happened" | "lesson", string>> = {}) => ({
  thesisId,
  expected: "Services would keep compounding and the market would rerate it.",
  happened: "Sold a day later at a 10% loss when the version dropped it.",
  lesson: "A one-day hold says nothing about the thesis; don't drop an idea on noise.",
  ...extra,
});

let db: Db;

beforeEach(async () => {
  ({ db } = await createTestDb());
  // v1 holds all three; v2 keeps MSFT only. AAPL then sells out (closed);
  // NVDA sells half (left, not flat); MSFT is still held (open).
  await db.insert(strategies).values([
    { authoredBy: "claude", createdAt: at("2026-11-02T13:00:00Z"), summary: "v1", document: strategy({ conviction: [AAPL, MSFT, NVDA] }) as unknown as Record<string, unknown> },
    { authoredBy: "claude", createdAt: at("2026-11-03T13:00:00Z"), summary: "v2", document: strategy({ conviction: [MSFT] }) as unknown as Record<string, unknown> },
  ]);
  await db.insert(brokerActivities).values([
    { id: "f1", type: "FILL", at: at("2026-11-02T14:45:00Z"), symbol: "AAPL", side: "buy", qty: "2", price: "100", raw: {} },
    { id: "f2", type: "FILL", at: at("2026-11-02T14:46:00Z"), symbol: "MSFT", side: "buy", qty: "1", price: "300", raw: {} },
    { id: "f3", type: "FILL", at: at("2026-11-02T14:47:00Z"), symbol: "NVDA", side: "buy", qty: "1", price: "50", raw: {} },
    { id: "f4", type: "FILL", at: at("2026-11-03T14:45:00Z"), symbol: "AAPL", side: "sell", qty: "2", price: "90", raw: {} },
    { id: "f5", type: "FILL", at: at("2026-11-03T14:46:00Z"), symbol: "NVDA", side: "sell", qty: "0.5", price: "55", raw: {} },
  ]);
  const syncedAt = at("2026-11-06T20:45:00Z");
  await db.insert(positions).values([
    { symbol: "MSFT", qty: "1", avgEntryPrice: "300", marketValue: "310", costBasis: "300", currentPrice: "310", syncedAt },
    { symbol: "NVDA", qty: "0.5", avgEntryPrice: "50", marketValue: "26", costBasis: "25", currentPrice: "52", syncedAt },
  ]);
  await db.insert(benchmarkCloses).values([
    { symbol: "VTI", tradingDate: "2026-11-02", close: "250" },
    { symbol: "VTI", tradingDate: "2026-11-03", close: "300" },
  ]);
});

describe("recordLessons (#28)", () => {
  it("refuses the whole batch for an unknown, open, not-yet-flat or repeated thesis, or text out of bounds", async () => {
    const r = await recordLessons(db, [lesson("nope"), lesson("msft-a"), lesson("nvda-a"), lesson("aapl-a"), lesson("aapl-a")], "claude", NOW);
    expect(r).toEqual({
      status: "rejected",
      errors: [
        'lessons[0].thesisId: "nope" isn\'t in the track record',
        'lessons[1].thesisId: "msft-a" is still in the strategy; a lesson waits until it closes',
        'lessons[2].thesisId: "nvda-a" left the strategy but its shares aren\'t all sold yet',
        'lessons[4].thesisId: "aapl-a" is the same thesis as an earlier lesson in this batch',
      ],
    });
    expect(await recordLessons(db, [lesson("aapl-a", { lesson: "too short" })], "claude", NOW)).toEqual({
      status: "rejected",
      errors: ["lessons.0.lesson: say what to do differently in a sentence or two"],
    });
    expect(await recordLessons(db, [], "claude", NOW)).toMatchObject({ status: "rejected", errors: ["needs at least one lesson"] });
    expect(await recordLessons(db, Array.from({ length: LESSON_LIMITS.perCall + 1 }, () => lesson("aapl-a")), "claude", NOW)).toMatchObject({ status: "rejected" });
    expect(await db.select().from(thesisLessons)).toEqual([]);
  });

  it("stores the lesson with the outcome frozen, audits it, and lets a later one replace it", async () => {
    expect(await recordLessons(db, [lesson("aapl-a")], "claude", NOW)).toEqual({ status: "recorded", recorded: [{ thesisId: "aapl-a", symbol: "AAPL", replaced: false }], stillDue: 0 });
    const [stored] = await latestLessons(db);
    // $200 bought, $180 back: −10%. The same $200 in VTI: 0.8 at $250, sold at $300: +20%.
    expect(stored).toMatchObject({
      thesisId: "aapl-a",
      symbol: "AAPL",
      primaryKind: "fundamental",
      ending: "removed",
      outcome: { daysHeld: 1, closedAt: "2026-11-03T14:45:00.000Z", returnPct: "-10", vtiPct: "20", excessPct: "-30" },
    });
    const [event] = await db.select().from(auditEvents);
    expect(event).toMatchObject({ actor: "claude", kind: "lessons.recorded", subject: "AAPL", payload: { lessons: [{ thesisId: "aapl-a", ending: "removed", excessPct: "-30", replaced: false }] } });

    const later = at("2026-11-09T14:00:00Z");
    expect(await recordLessons(db, [lesson("aapl-a", { lesson: "Revised: the version dropped it for a better idea, which was the right call." })], "claude", later)).toMatchObject({
      recorded: [{ replaced: true }],
    });
    expect(await db.select().from(thesisLessons)).toHaveLength(2);
    expect((await latestLessons(db)).map((l) => l.lesson)).toEqual(["Revised: the version dropped it for a better idea, which was the right call."]);
  });
});

describe("lessonFor and rowsDueLessons", () => {
  const row = (ids: string[], closedAt: string | null) => ({ ids, closedAt: closedAt ? at(closedAt) : null }) as ScorecardRow;
  const l = (thesisId: string) => ({ thesisId }) as Awaited<ReturnType<typeof latestLessons>>[number];

  it("matches a lesson on any of a row's ids (a successor that took over the shares), and lists closed rows without one, latest close first", () => {
    const rows = [row(["a-1", "a-2"], "2026-11-03T15:00:00Z"), row(["b-1"], "2026-11-04T15:00:00Z"), row(["c-1"], null)];
    expect(lessonFor(rows[0]!, [l("a-2")])).toEqual(l("a-2"));
    expect(rowsDueLessons(rows, [l("a-2")]).map((r) => r.ids[0])).toEqual(["b-1"]);
    expect(rowsDueLessons(rows, []).map((r) => r.ids[0])).toEqual(["b-1", "a-1"]);
  });
});

describe("lastListedVersions", () => {
  it("gives the last version listing each id", async () => {
    expect(await lastListedVersions(db, ["aapl-a", "msft-a", "zzz"])).toEqual(new Map([["msft-a", 2], ["aapl-a", 1]]));
    expect(await lastListedVersions(db, [])).toEqual(new Map());
  });
});

describe("the tools", () => {
  it("get_track_record lists closed theses due a lesson, then shows the lesson on the row", async () => {
    const deps = { db, now: NOW };
    const before = await getTrackRecord(deps);
    expect(before.lessonsDue).toEqual([{ thesisId: "aapl-a", ids: ["aapl-a"], symbol: "AAPL", primaryKind: "fundamental", ending: "removed", closedAt: "2026-11-03T14:45:00.000Z", lastVersion: 1 }]);
    expect(before.theses.find((t) => t.symbol === "AAPL")).toMatchObject({ lesson: null });
    expect(before.theses.find((t) => t.symbol === "MSFT")).not.toHaveProperty("lesson");

    expect(await recordLessonTool(deps, [lesson("aapl-a")])).toMatchObject({ status: "recorded" });
    const after = await getTrackRecord(deps);
    expect(after.lessonsDue).toEqual([]);
    expect(after.theses.find((t) => t.symbol === "AAPL")).toMatchObject({ lesson: { thesisId: "aapl-a", lesson: lesson("aapl-a").lesson, outcome: { excessPct: "-30" } } });
  });

  it("check_eligibility carries past lessons for each symbol", async () => {
    await recordLessons(db, [lesson("aapl-a")], "claude", NOW);
    const broker = new FakeBroker();
    broker.now = NOW;
    const [aapl, msft] = (await checkEligibility({ db, broker, env: "staging", now: NOW }, ["AAPL", "MSFT"])) as { pastLessons: unknown[] }[];
    expect(aapl!.pastLessons).toEqual([{ thesisId: "aapl-a", ending: "removed", primaryKind: "fundamental", excessPct: "-30", daysHeld: 1, lesson: lesson("aapl-a").lesson, at: NOW.toISOString() }]);
    expect(msft!.pastLessons).toEqual([]);
  });
});
