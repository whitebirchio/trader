import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import {
  type Config,
  type Db,
  type JobName,
  getHealth,
  parseConfig,
  runJob,
  slotFor,
} from "@trader/core";

/** Cron expression → jobs it runs, in order. Must match `triggers.crons` in wrangler.jsonc. */
const SCHEDULE: Record<string, JobName[]> = {
  "*/15 * * * *": ["heartbeat"],
};

/**
 * One Pool per invocation: Workers can't reuse sockets across requests. The
 * WebSocket driver (not neon-http) is used so later modules get transactions.
 */
async function withDb<T>(
  config: Config,
  ctx: ExecutionContext,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    return await fn(drizzle(pool, { casing: "snake_case" }) as unknown as Db);
  } finally {
    ctx.waitUntil(pool.end());
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async scheduled(controller, env, ctx): Promise<void> {
    const parsed = parseConfig(env);
    if (!parsed.ok) {
      // Fail closed: run nothing. Names only — never values.
      console.error("config invalid; no jobs run", { missing: parsed.missing, invalid: parsed.invalid });
      return;
    }
    const jobs = SCHEDULE[controller.cron];
    if (!jobs) {
      console.error("no jobs registered for cron", { cron: controller.cron });
      return;
    }
    const scheduledFor = slotFor(controller.scheduledTime);
    await withDb(parsed.config, ctx, async (db) => {
      for (const job of jobs) {
        const outcome = await runJob(db, parsed.config.tradingEnv, job, scheduledFor);
        console.log("job", { job, scheduledFor: scheduledFor.toISOString(), ...outcome });
      }
    });
  },

  async fetch(request, env, ctx): Promise<Response> {
    const parsed = parseConfig(env);
    if (!parsed.ok) {
      return json({ error: "misconfigured", missing: parsed.missing, invalid: parsed.invalid }, 503);
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      const health = await withDb(parsed.config, ctx, (db) =>
        getHealth(db, parsed.config.tradingEnv, new Date()),
      );
      return json(health, health.status === "healthy" ? 200 : 503);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
