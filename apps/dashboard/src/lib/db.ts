import { neon } from "@neondatabase/serverless";
import type { Db } from "@trader/core";
import { drizzle } from "drizzle-orm/neon-http";

/**
 * The dashboard's database: Neon over HTTP (stateless per query, so nothing
 * breaks when an idle environment is frozen) as trader_dashboard, which can
 * only SELECT. The read models never open transactions.
 */
let cached: { url: string; db: Db } | null = null;

export function dbFor(url: string): Db {
  if (cached?.url === url) return cached.db;
  const db = drizzle(neon(url), { casing: "snake_case" }) as unknown as Db;
  cached = { url, db };
  return db;
}
