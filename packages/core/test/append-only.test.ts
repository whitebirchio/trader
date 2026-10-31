import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { APPEND_ONLY_TABLES } from "../src/db/schema.js";
import { createTestDb } from "./helpers.js";

let pglite: PGlite;

beforeEach(async () => {
  ({ pglite } = await createTestDb());
  await pglite.exec(`
    INSERT INTO audit_events (actor, kind) VALUES ('system', 'job.failed');
    INSERT INTO broker_activities (id, type, at, raw) VALUES ('a-1', 'DIV', now(), '{}');
  `);
});

describe.each(APPEND_ONLY_TABLES)("%s is append-only (ADR-008)", (table) => {
  it("rejects UPDATE", async () => {
    await expect(pglite.exec(`UPDATE ${table} SET id = id`)).rejects.toThrow(/append-only/);
  });
  it("rejects DELETE", async () => {
    await expect(pglite.exec(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
  });
  it("rejects TRUNCATE", async () => {
    await expect(pglite.exec(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
  });
});
