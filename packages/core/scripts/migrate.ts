/**
 * Apply pending migrations (idempotent — drizzle tracks applied migrations in
 * __drizzle_migrations and skips them). Run with the branch's OWNER role: the
 * Worker's trader_app role cannot run DDL.
 *
 * Uses the Neon HTTP driver rather than drizzle-kit's auto-selected client; it
 * speaks Neon's TLS natively and needs no WebSocket under plain Node.
 *
 * Usage: DATABASE_URL=postgres://... npm run db:migrate -w @trader/core
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (owner-role Neon URL; see docs/SETUP.md).");
  process.exit(1);
}

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const host = new URL(url).host;

console.log(`Migrating ${host} …`);
const db = drizzle(neon(url), { casing: "snake_case" });
await migrate(db, { migrationsFolder });
console.log("Migrations applied.");
