import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { BrokerAdapter } from "../src/broker/port.js";
import type { Db } from "../src/db/client.js";
import type { TradingEnv } from "../src/env.js";
import type { JobDeps } from "../src/jobs.js";
import { migratedPglite } from "../src/replay/db.js";
import { FakeBroker } from "./broker/fake-broker.js";
import { FakeMailer } from "./notifications/fake-mailer.js";

// Migrated once per test file, then cloned for each test: a clone copies the
// migrated database (about 4× faster than replaying every migration) and is
// fully independent of the template and of other clones.
let template: Promise<PGlite> | null = null;

/**
 * Fresh in-memory Postgres with all real migrations applied. PGlite runs as
 * superuser, so role grants are not exercised here — the append-only trigger
 * is, and docs/SETUP.md verifies the grants against Neon.
 */
export async function createTestDb(): Promise<{ db: Db; pglite: PGlite }> {
  template ??= migratedPglite();
  const pglite = (await (await template).clone()) as PGlite;
  const db = drizzle(pglite, { casing: "snake_case" }) as unknown as Db;
  return { db, pglite };
}

/** Job dependencies over a test DB; the broker defaults to an empty fake. */
export function deps(
  db: Db,
  env: TradingEnv = "staging",
  broker: BrokerAdapter = new FakeBroker(),
  mailer: FakeMailer = new FakeMailer(),
): JobDeps {
  return { db, env, broker, mailer, now: () => new Date() };
}
