import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { getHealth } from "../src/health.js";
import { runJob } from "../src/jobs.js";
import { createTestDb, deps } from "./helpers.js";

let db: Db;
const t0 = new Date("2026-11-02T14:30:00Z");
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("getHealth", () => {
  it("is unhealthy before any heartbeat", async () => {
    expect(await getHealth(db, "staging", t0)).toEqual({
      env: "staging",
      status: "unhealthy",
      lastHeartbeatAt: null,
      reason: "no heartbeat recorded yet",
    });
  });

  it("is healthy within 30 minutes of the last successful heartbeat", async () => {
    await runJob(deps(db, "staging"), "heartbeat", t0);
    const health = await getHealth(db, "staging", minutes(30));
    expect(health.status).toBe("healthy");
    expect(health.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(health.reason).toBeUndefined();
  });

  it("is unhealthy once the last heartbeat is stale", async () => {
    await runJob(deps(db, "staging"), "heartbeat", t0);
    const health = await getHealth(db, "staging", minutes(90));
    expect(health.status).toBe("unhealthy");
    expect(health.reason).toMatch(/minutes ago/);
  });

  it("ignores failed heartbeats", async () => {
    await runJob(deps(db, "staging"), "heartbeat", t0, async () => {
      throw new Error("db hiccup");
    });
    expect((await getHealth(db, "staging", minutes(1))).status).toBe("unhealthy");
  });
});
