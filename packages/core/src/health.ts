import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { jobRuns } from "./db/schema.js";
import type { TradingEnv } from "./env.js";

/** The heartbeat cron fires every 15 minutes; two missed beats is unhealthy. */
export const HEARTBEAT_MAX_AGE_MS = 30 * 60_000;

export interface Health {
  env: TradingEnv;
  status: "healthy" | "unhealthy";
  /** Scheduled time of the most recent successful heartbeat. */
  lastHeartbeatAt: Date | null;
  reason?: string;
}

/** Liveness for /healthz. Deliberately reveals nothing about the account or positions. */
export async function getHealth(db: Db, env: TradingEnv, now: Date): Promise<Health> {
  const rows = await db
    .select({ scheduledFor: jobRuns.scheduledFor })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "heartbeat"), eq(jobRuns.status, "succeeded")))
    .orderBy(desc(jobRuns.scheduledFor))
    .limit(1);
  const last = rows[0]?.scheduledFor ?? null;

  if (!last) {
    return { env, status: "unhealthy", lastHeartbeatAt: null, reason: "no heartbeat recorded yet" };
  }
  const ageMs = now.getTime() - last.getTime();
  if (ageMs > HEARTBEAT_MAX_AGE_MS) {
    const ago = Math.round(ageMs / 60_000);
    return { env, status: "unhealthy", lastHeartbeatAt: last, reason: `last heartbeat ${ago} minutes ago` };
  }
  return { env, status: "healthy", lastHeartbeatAt: last };
}
