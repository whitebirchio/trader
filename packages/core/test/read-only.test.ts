import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { writableTables } from "../src/db/read-only.js";
import { createTestDb } from "./helpers.js";

describe("writableTables (ADR-018)", () => {
  it("lists every table for an owner, and none for a SELECT-only role like the dashboard's", async () => {
    const { db } = await createTestDb();
    expect(await writableTables(db)).toEqual(expect.arrayContaining(["audit_events", "job_runs", "risk_state"]));

    await db.execute(sql`create role reader`);
    await db.execute(sql`grant usage on schema public to reader`);
    await db.execute(sql`grant select on all tables in schema public to reader`);
    await db.execute(sql`set role reader`);
    expect(await writableTables(db)).toEqual([]);

    await db.execute(sql`reset role`);
    await db.execute(sql`grant update on job_runs to reader`);
    await db.execute(sql`set role reader`);
    expect(await writableTables(db)).toEqual(["job_runs"]);
  });
});
