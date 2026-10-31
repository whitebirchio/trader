import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { recordEvent } from "../src/audit.js";
import type { Db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";
import { createTestDb } from "./helpers.js";

let db: Db;

/** Drizzle wraps driver errors ("Failed query: …"); the trigger's message is on `cause`. */
async function rejection(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected the query to be rejected");
}

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("recordEvent", () => {
  it("appends an event", async () => {
    const event = await recordEvent(db, {
      actor: "system",
      kind: "job.failed",
      subject: "heartbeat",
      payload: { error: "boom" },
    });
    expect(event).toMatchObject({ actor: "system", kind: "job.failed", subject: "heartbeat" });
    expect(event.at).toBeInstanceOf(Date);
    const rows = await db.select().from(auditEvents);
    expect(rows).toHaveLength(1);
  });

  it("defaults payload to {} and subject to null", async () => {
    const event = await recordEvent(db, { actor: "owner", kind: "job.failed" });
    expect(event.payload).toEqual({});
    expect(event.subject).toBeNull();
  });
});

describe("audit_events is append-only (ADR-008)", () => {
  it("rejects UPDATE", async () => {
    const event = await recordEvent(db, { actor: "system", kind: "job.failed" });
    expect(
      await rejection(
        db.update(auditEvents).set({ kind: "edited" }).where(eq(auditEvents.id, event.id)),
      ),
    ).toMatch(/append-only/);
  });

  it("rejects DELETE", async () => {
    const event = await recordEvent(db, { actor: "system", kind: "job.failed" });
    expect(await rejection(db.delete(auditEvents).where(eq(auditEvents.id, event.id)))).toMatch(
      /append-only/,
    );
  });

  it("rejects TRUNCATE", async () => {
    await recordEvent(db, { actor: "system", kind: "job.failed" });
    expect(await rejection(db.execute(sql`truncate audit_events cascade`))).toMatch(/append-only/);
  });
});
