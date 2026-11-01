/**
 * Create (or rotate) the engine's least-privilege role, `trader_app`, on one
 * Neon branch, then prove the privileges by connecting AS that role (ADR-008).
 *
 * Run with the branch's OWNER role. Roles are per-branch in Neon, so run it
 * once per branch. Re-running rotates the password, so store the new URL
 * (scripts/set-db-secret.sh does both).
 *
 * Usage:
 *   DATABASE_URL=<owner url> APP_ROLE_PASSWORD=<alphanumeric> \
 *     npm run db:app-role -w @trader/core [-- --print-url]
 *
 * With --print-url, the app-role connection string is the ONLY thing written
 * to stdout (so it can be piped into scripts/put-ssm-secret.sh); everything else
 * goes to stderr.
 *
 * Why SQL rather than the Neon console: console-created roles join
 * neon_superuser, which would make a second admin rather than an app user.
 */
import { neon } from "@neondatabase/serverless";
import { APPEND_ONLY_TABLES } from "../src/db/schema.js";

const ROLE = "trader_app";
const ownerUrl = process.env.DATABASE_URL;
const password = process.env.APP_ROLE_PASSWORD;
const log = (msg: string) => process.stderr.write(`${msg}\n`);

if (!ownerUrl) throw new Error("DATABASE_URL (owner role) is not set");
// Alphanumeric only: the password is embedded in a postgresql:// URL, and it
// is interpolated into CREATE ROLE (which cannot take a bind parameter).
if (!password || !/^[A-Za-z0-9]{24,}$/.test(password)) {
  throw new Error("APP_ROLE_PASSWORD must be 24+ alphanumeric characters");
}

const owner = neon(ownerUrl);
log(`Configuring ${ROLE} on ${new URL(ownerUrl).host} …`);

await owner.query(`
  DO $$
  BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
      ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${password}';
    ELSE
      CREATE ROLE ${ROLE} WITH LOGIN PASSWORD '${password}';
    END IF;
  END $$`);

const statements = [
  // Neon's owner can't touch SUPERUSER/REPLICATION/BYPASSRLS even to clear them;
  // SQL-created roles start without them, and the check below verifies that.
  `ALTER ROLE ${ROLE} NOCREATEDB NOCREATEROLE NOINHERIT`,
  `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database()); END $$`,
  `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
  // No DDL from the engine, ever: migrations run from CI or a laptop as owner.
  `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
  `REVOKE CREATE ON SCHEMA public FROM ${ROLE}`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`,
  // Tables added by later migrations get the same DML grants automatically…
  `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`,
  // …except append-only tables (ADR-008); their triggers are the other layer.
  ...APPEND_ONLY_TABLES.map((t) => `REVOKE UPDATE, DELETE, TRUNCATE ON ${t} FROM ${ROLE}`),
];
for (const statement of statements) await owner.query(statement);

// The attributes that separate an app user from an administrator, and
// membership in neon_superuser (which console-created roles get).
const [attrs] = (await owner.query(
  `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
          pg_has_role($1, 'neon_superuser', 'MEMBER') AS neon_superuser
     FROM pg_roles WHERE rolname = $1`,
  [ROLE],
)) as Record<string, boolean>[];
const powers = Object.entries(attrs ?? {}).filter(([, on]) => on).map(([name]) => name);
if (!attrs || powers.length > 0) throw new Error(`${ROLE} has admin powers: ${powers.join(", ")}`);
log("  ✓ no superuser/createdb/createrole/replication/bypassrls/neon_superuser");

const grants = await owner.query(
  `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
     FROM information_schema.role_table_grants
    WHERE grantee = $1 GROUP BY table_name ORDER BY table_name`,
  [ROLE],
);
for (const g of grants as { table_name: string; privileges: string }[]) {
  log(`  ${g.table_name}: ${g.privileges}`);
}

// Prove it as the role itself. Neither probe can change data: the CREATE must
// be refused, and an UPDATE … WHERE false is still privilege-checked.
const appUrl = new URL(ownerUrl);
appUrl.username = ROLE;
appUrl.password = password;
const app = neon(appUrl.toString());

async function expectDenied(label: string, query: string): Promise<void> {
  try {
    await app.query(query);
  } catch (e) {
    if (/permission denied/i.test(String((e as Error).message))) {
      log(`  ✓ ${label}: permission denied`);
      return;
    }
    throw e;
  }
  throw new Error(`${label} was NOT denied for ${ROLE}`);
}

await app.query("SELECT count(*) FROM job_runs");
log("  ✓ can read job_runs");
for (const t of APPEND_ONLY_TABLES) {
  await expectDenied(`UPDATE ${t}`, `UPDATE ${t} SET id = id WHERE false`);
  await expectDenied(`DELETE ${t}`, `DELETE FROM ${t} WHERE false`);
}
await expectDenied("CREATE TABLE", "CREATE TABLE trader_app_probe (id int)");
log(`${ROLE} ready.`);

if (process.argv.includes("--print-url")) process.stdout.write(appUrl.toString());
