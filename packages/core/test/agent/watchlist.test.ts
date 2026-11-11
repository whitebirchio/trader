import { beforeEach, describe, expect, it } from "vitest";
import { WATCHLIST_LIMITS, readWatchlist, updateWatchlist, watchlistSummary } from "../../src/agent/watchlist.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, watchlistNotes } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";

let db: Db;
const NOW = new Date("2026-11-11T17:00:00Z"); // Wednesday, market date 2026-11-11
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const watch = (symbol: string, revisitBy = "2026-12-15", over: object = {}) => ({ action: "watch", symbol, why: `${symbol} looked good but missed the bar`, trigger: `${symbol} files a 10-Q confirming the turn`, revisitBy, ...over });
const drop = (symbol: string) => ({ action: "drop", symbol, why: "the catalyst passed without a move" });

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("updateWatchlist and readWatchlist (#32)", () => {
  it("adds names, lists them soonest revisit first, and audits the change once", async () => {
    expect(await updateWatchlist(db, [watch("UPBD", "2026-12-15"), watch("HGV", "2026-12-01")], "claude", NOW)).toEqual({ status: "updated", watched: ["UPBD", "HGV"], dropped: [], open: 2 });
    const { open } = await readWatchlist(db, NOW);
    expect(open.map((e) => [e.symbol, e.revisitBy, e.daysToRevisit, e.due])).toEqual([["HGV", "2026-12-01", 20, false], ["UPBD", "2026-12-15", 34, false]]);
    expect(open[0]).toMatchObject({ why: "HGV looked good but missed the bar", trigger: "HGV files a 10-Q confirming the turn" });
    const events = (await db.select().from(auditEvents)).filter((e) => e.kind === "watchlist.updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "claude", subject: "UPBD, HGV", payload: { open: 2, watched: [{ symbol: "UPBD", new: true }, { symbol: "HGV", new: true }], dropped: [] } });
  });

  it("replaces a name's note when watched again, keeps when it went on, and drops it", async () => {
    await updateWatchlist(db, [watch("UPBD", "2026-12-15")], "claude", NOW);
    await updateWatchlist(db, [watch("UPBD", "2026-12-20", { trigger: "Q4 guidance confirms the recovery" })], "claude", later(2));
    let { open } = await readWatchlist(db, later(2));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ revisitBy: "2026-12-20", trigger: "Q4 guidance confirms the recovery", watchedSince: NOW.toISOString(), updatedAt: later(2).toISOString() });

    expect(await updateWatchlist(db, [drop("UPBD")], "claude", later(3))).toMatchObject({ status: "updated", dropped: ["UPBD"], open: 0 });
    const after = await readWatchlist(db, later(3));
    expect(after.open).toEqual([]);
    expect(after.recentlyDropped).toEqual([{ symbol: "UPBD", why: "the catalyst passed without a move", at: later(3).toISOString() }]);
    expect((await readWatchlist(db, later(20))).recentlyDropped).toEqual([]); // older than 14 days

    // Watched again after a drop: a fresh start.
    await updateWatchlist(db, [watch("UPBD", "2027-01-15")], "claude", later(30));
    ({ open } = await readWatchlist(db, later(30)));
    expect(open[0]).toMatchObject({ watchedSince: later(30).toISOString() });
  });

  it("marks a name due once its revisit date has passed, and the summary names it", async () => {
    await updateWatchlist(db, [watch("UPBD", "2026-11-13"), watch("HGV", "2026-12-01")], "claude", NOW);
    expect(await watchlistSummary(db, later(3))).toEqual({ open: 2, due: ["UPBD"] });
    const { open } = await readWatchlist(db, later(3));
    expect(open[0]).toMatchObject({ symbol: "UPBD", due: true, daysToRevisit: -1 });
  });

  it("rejects the whole batch for any bad change, and writes nothing", async () => {
    const bad = await updateWatchlist(db, [watch("UPBD"), watch("upbd"), watch("HGV", "2026-11-11"), watch("LKQ", "2027-04-01"), drop("ZZZ"), { action: "watch", symbol: "AN", why: "short" }], "claude", NOW);
    expect(bad.status).toBe("rejected");
    expect(bad.status === "rejected" && bad.errors).toEqual(expect.arrayContaining([expect.stringContaining("must be a ticker"), expect.stringContaining("say why in a sentence")]));
    expect(await db.select().from(watchlistNotes)).toEqual([]);

    const dates = await updateWatchlist(db, [watch("HGV", "2026-11-11"), watch("LKQ", "2027-04-01"), watch("AN", "2026-02-30"), drop("ZZZ"), watch("BA"), watch("BA")], "claude", NOW);
    expect(dates).toEqual({
      status: "rejected",
      errors: [
        "changes[0].revisitBy: must be after today (2026-11-11)",
        `changes[1].revisitBy: at most ${WATCHLIST_LIMITS.revisitMaxDays} days out`,
        "changes[2].revisitBy: must be a real date",
        "changes[3]: ZZZ isn't on the watchlist",
        "changes[5]: BA appears more than once",
      ],
    });
    expect(await updateWatchlist(db, [], "claude", NOW)).toMatchObject({ status: "rejected", errors: ["needs at least one change"] });
  });

  it("holds at most the open limit, counting drops in the same batch", async () => {
    const many = Array.from({ length: WATCHLIST_LIMITS.open }, (_, i) => watch(`S${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`));
    for (let i = 0; i < many.length; i += WATCHLIST_LIMITS.perCall) expect((await updateWatchlist(db, many.slice(i, i + WATCHLIST_LIMITS.perCall), "claude", NOW)).status).toBe("updated");
    expect(await updateWatchlist(db, [watch("UPBD")], "claude", NOW)).toMatchObject({ status: "rejected", errors: [expect.stringContaining(`at most ${WATCHLIST_LIMITS.open}`)] });
    expect(await updateWatchlist(db, [drop(many[0]!.symbol), watch("UPBD")], "claude", NOW)).toMatchObject({ status: "updated", open: WATCHLIST_LIMITS.open });
  });

  it("is insert-only: a row can't be changed or removed", async () => {
    await updateWatchlist(db, [watch("UPBD")], "claude", NOW);
    await expect(db.update(watchlistNotes).set({ why: "rewritten history" })).rejects.toThrow();
    await expect(db.delete(watchlistNotes)).rejects.toThrow();
  });
});
