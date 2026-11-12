import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@trader/core";
import { jobRuns } from "../../../packages/core/src/db/schema.js";
import { FakeBroker } from "../../../packages/core/test/broker/fake-broker.js";
import { createTestDb } from "../../../packages/core/test/helpers.js";
import { FakeMailer } from "../../../packages/core/test/notifications/fake-mailer.js";
import { createHandler, type HandlerDeps } from "../src/handler.js";

const ENV = {
  TRADING_ENV: "staging",
  DATABASE_URL: "postgresql://trader_app:x@ep-test-pooler.us-east-1.aws.neon.tech/neondb",
  ALPACA_KEY_ID: "PKTESTKEY0000000000000000A",
  ALPACA_SECRET_KEY: "secret0000000000000000000000000000000000000",
};

let db: Db;
let env: Record<string, unknown>;
let logs: { level: string; message: string; detail?: Record<string, unknown> }[];
let closed: number;
const broker = new FakeBroker();
broker.clock.isOpen = false; // keep sync-broker on its cheap skip path
const now = new Date("2026-11-01T17:07:30Z"); // Sunday

beforeEach(async () => {
  ({ db } = await createTestDb());
  env = { ...ENV };
  logs = [];
  closed = 0;
});

const deps = (): HandlerDeps => ({
  loadEnv: async () => env,
  openDb: async () => ({ db, close: async () => void closed++ }),
  makeBroker: () => broker,
  makeMailer: () => new FakeMailer(),
  now: () => now,
  log: (level, message, detail) => logs.push({ level, message, detail }),
});

const http = (method: string, rawPath: string) =>
  ({ rawPath, requestContext: { http: { method } } }) as unknown as APIGatewayProxyEventV2;

describe("scheduled ticks", () => {
  it("runs the requested jobs in order for the event's slot", async () => {
    const handler = createHandler(deps());
    const result = await handler({ jobs: ["heartbeat", "sync-broker"], scheduledTime: "2026-11-01T17:00:00Z" });
    expect(result).toMatchObject({
      status: "ok",
      results: [
        { job: "heartbeat", status: "succeeded" },
        { job: "sync-broker", status: "skipped", reason: "market closed" },
      ],
    });
    const runs = await db.select().from(jobRuns);
    expect(runs.map((r) => [r.job, r.scheduledFor.toISOString()])).toEqual([
      ["heartbeat", "2026-11-01T17:00:00.000Z"],
      ["sync-broker", "2026-11-01T17:00:00.000Z"],
    ]);
    expect(closed).toBe(1);
  });

  it("treats a redelivered tick as a no-op (ADR-007)", async () => {
    const handler = createHandler(deps());
    await handler({ jobs: ["heartbeat"], scheduledTime: "2026-11-01T17:00:00Z" });
    const again = await handler({ jobs: ["heartbeat"], scheduledTime: "2026-11-01T17:00:00Z" });
    expect(again).toMatchObject({ results: [{ job: "heartbeat", status: "duplicate" }] });
  });

  it("defaults to the full tick and the current minute", async () => {
    const result = (await createHandler(deps())({})) as { results: { job: string }[] };
    expect(result.results.map((r) => r.job)).toEqual(["heartbeat", "sync-broker", "process-capital", "earnings-calendar", "check-filings", "earnings-backfill", "notify-urgent", "notify-digest", "notify-weekly"]);
    expect((await db.select().from(jobRuns))[0]?.scheduledFor.toISOString()).toBe("2026-11-01T17:07:00.000Z");
  });

  it("refuses unknown jobs and bad times", async () => {
    const handler = createHandler(deps());
    await expect(handler({ jobs: ["heartbeat", "drop-tables"] })).rejects.toThrow("unknown jobs: drop-tables");
    await expect(handler({ scheduledTime: "yesterday" })).rejects.toThrow("invalid scheduledTime");
  });

  it("fails loudly on bad config, naming the vars and never their values", async () => {
    env = { ...ENV, DATABASE_URL: undefined, ALPACA_SECRET_KEY: "short" };
    await expect(createHandler(deps())({ jobs: ["heartbeat"] })).rejects.toThrow("config invalid: DATABASE_URL, ALPACA_SECRET_KEY");
    expect(logs[0]).toMatchObject({ level: "error", detail: { missing: ["DATABASE_URL"], invalid: ["ALPACA_SECRET_KEY"] } });
    expect(JSON.stringify(logs)).not.toContain("short");
  });
});

describe("Function URL", () => {
  it("serves /healthz", async () => {
    const handler = createHandler(deps());
    expect(await handler(http("GET", "/healthz"))).toMatchObject({ statusCode: 503 }); // no heartbeat yet
    await handler({ jobs: ["heartbeat"], scheduledTime: "2026-11-01T17:00:00Z" });
    const ok = (await handler(http("GET", "/healthz"))) as { statusCode: number; body: string };
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ env: "staging", status: "healthy" });
  });

  it("404s anything else", async () => {
    expect(await createHandler(deps())(http("POST", "/healthz"))).toMatchObject({ statusCode: 404 });
    expect(await createHandler(deps())(http("GET", "/admin"))).toMatchObject({ statusCode: 404 });
  });

  it("returns 503 naming missing config", async () => {
    env = { TRADING_ENV: "staging" };
    const res = (await createHandler(deps())(http("GET", "/healthz"))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "misconfigured", missing: ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY", "DATABASE_URL"], invalid: [] });
  });
});
