import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { jobRuns } from "../src/db/schema.js";
import { mul } from "../src/money.js";
import { createTestDb } from "./helpers.js";

let db: Db;
let pglite: PGlite;

beforeAll(async () => {
  ({ db, pglite } = await createTestDb());
});

describe("schema", () => {
  it("applies every migration and creates the foundation tables", async () => {
    const rows = await pglite.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual(["audit_events", "job_runs"]);
  });

  it("enforces one job_runs row per (job, scheduled_for)", async () => {
    const scheduledFor = new Date("2026-11-02T14:30:00Z");
    await db.insert(jobRuns).values({ job: "heartbeat", scheduledFor, status: "running" });
    await expect(
      db.insert(jobRuns).values({ job: "heartbeat", scheduledFor, status: "running" }),
    ).rejects.toThrow();
  });

  it("round-trips numeric as an exact decimal string (ADR-009)", async () => {
    const qty = "0.333648737";
    const rows = await pglite.query<{ q: unknown; n: unknown }>(
      "select $1::numeric(20,9) as q, $1::numeric * '412.17'::numeric as n",
      [qty],
    );
    const row = rows.rows[0];
    expect(row?.q).toBe(qty);
    // Postgres and big.js agree to the last digit.
    expect(row?.n).toBe(mul(qty, "412.17"));
  });
});
