/**
 * Create (or rotate) the dashboard's role, `trader_dashboard`, on one Neon
 * branch, then prove it can read, can INSERT owner commands into
 * capital_commands (its one write, SPEC-capital / ADR-015), and can write
 * nothing else (SPEC-dashboard). Migration 0016 grants the same INSERT on
 * branches where the role already exists, so this needn't be re-run for it.
 *
 * Run with the branch's OWNER role, once per branch. Re-running rotates the
 * password, so store the new URL (scripts/set-dashboard-secrets.sh does both).
 *
 *   DATABASE_URL=<owner url> DASHBOARD_ROLE_PASSWORD=<alphanumeric> \
 *     npm run db:dashboard-role -w @trader/core [-- --print-url]
 *
 * With --check, it changes nothing: it runs the same grant checks and probes
 * against the existing role, connecting with its stored URL.
 *
 *   DATABASE_URL=<owner url> DASHBOARD_READ_URL=<the role's url> \
 *     npm run db:dashboard-role -w @trader/core -- --check
 *
 * With --print-url, the role's connection string is the ONLY thing written to
 * stdout (for scripts/put-ssm-secret.sh); everything else goes to stderr.
 */
import { neon } from "@neondatabase/serverless";

const ROLE = "trader_dashboard";
const ownerUrl = process.env.DATABASE_URL;
const check = process.argv.includes("--check");
const password = check ? decodeURIComponent(new URL(process.env.DASHBOARD_READ_URL ?? "postgres://x@h").password) : process.env.DASHBOARD_ROLE_PASSWORD;
const log = (msg: string) => process.stderr.write(`${msg}\n`);

if (!ownerUrl) throw new Error("DATABASE_URL (owner role) is not set");
if (check && !process.env.DASHBOARD_READ_URL) throw new Error("--check needs DASHBOARD_READ_URL (the role's stored URL)");
// Alphanumeric only: it's embedded in a URL and interpolated into CREATE ROLE.
if (!password || !/^[A-Za-z0-9]{24,}$/.test(password)) {
  throw new Error("DASHBOARD_ROLE_PASSWORD must be 24+ alphanumeric characters");
}

const owner = neon(ownerUrl);
log(`${check ? "Checking" : "Configuring"} ${ROLE} on ${new URL(ownerUrl).host} …`);
if (!check) await configure();

async function configure(): Promise<void> {
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
    `ALTER ROLE ${ROLE} NOCREATEDB NOCREATEROLE NOINHERIT`,
    // Every statement this role runs is read-only, whatever it asks for.
    `ALTER ROLE ${ROLE} SET default_transaction_read_only = on`,
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database()); END $$`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
    `REVOKE CREATE ON SCHEMA public FROM ${ROLE}`,
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${ROLE}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
    // Tables added by later migrations are readable too, and nothing more.
    `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE}`,
    // Its one write: owner withdrawal commands, which the engine validates (ADR-015).
    `GRANT INSERT ON capital_commands TO ${ROLE}`,
  ];
  for (const statement of statements) await owner.query(statement);
}

const [attrs] = (await owner.query(
  `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
          pg_has_role($1, 'neon_superuser', 'MEMBER') AS neon_superuser
     FROM pg_roles WHERE rolname = $1`,
  [ROLE],
)) as Record<string, boolean>[];
const powers = Object.entries(attrs ?? {}).filter(([, on]) => on).map(([name]) => name);
if (!attrs || powers.length > 0) throw new Error(`${ROLE} has admin powers: ${powers.join(", ")}`);
log("  ✓ no superuser/createdb/createrole/replication/bypassrls/neon_superuser");

const writes = (await owner.query(
  `SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = $1 AND privilege_type <> 'SELECT'`,
  [ROLE],
)) as { table_name: string; privilege_type: string }[];
const unexpected = writes.filter((w) => !(w.table_name === "capital_commands" && w.privilege_type === "INSERT"));
if (unexpected.length > 0 || writes.length !== 1) {
  throw new Error(`${ROLE} grants must be SELECT plus INSERT on capital_commands; found ${JSON.stringify(writes)}`);
}
log("  ✓ SELECT, plus INSERT on capital_commands only");

// Prove it as the role. None of these probes can change data.
// --check connects exactly as the dashboard does, with its stored URL.
const roleUrl = new URL(check ? process.env.DASHBOARD_READ_URL! : ownerUrl);
if (!check) {
  roleUrl.username = ROLE;
  roleUrl.password = password;
}
const reader = neon(roleUrl.toString());

async function expectDenied(label: string, query: string): Promise<void> {
  try {
    await reader.query(query);
  } catch (e) {
    if (/permission denied|read-only transaction/i.test(String((e as Error).message))) {
      log(`  ✓ ${label}: denied`);
      return;
    }
    throw e;
  }
  throw new Error(`${label} was NOT denied for ${ROLE}`);
}

/**
 * The same probe in a READ WRITE transaction, the way the dashboard writes.
 * neon-http's `readOnly: false` doesn't override the role's read-only
 * default (found on staging, 2026-11-02), so it's set as the first
 * statement instead.
 */
async function expectDeniedReadWrite(label: string, query: string): Promise<void> {
  try {
    await reader.transaction([reader.query("SET TRANSACTION READ WRITE"), reader.query(query)]);
  } catch (e) {
    if (/permission denied|append-only/i.test(String((e as Error).message))) {
      log(`  ✓ ${label} (read-write): denied`);
      return;
    }
    throw e;
  }
  throw new Error(`${label} was NOT denied for ${ROLE} in a read-write transaction`);
}

await reader.query("SELECT count(*) FROM strategies");
log("  ✓ can read strategies");
await expectDenied("INSERT", "INSERT INTO equity_snapshots (trading_date, equity, cash, long_market_value) SELECT current_date, 1, 1, 1 WHERE false");
await expectDenied("UPDATE", "UPDATE risk_state SET kill_switch = kill_switch WHERE false");
await expectDenied("DELETE", "DELETE FROM positions WHERE false");
await expectDenied("CREATE TABLE", "CREATE TABLE trader_dashboard_probe (id int)");
// Its one write works only in a read-write transaction (WHERE false: no row is written)…
await expectDenied("INSERT capital_commands (default read-only)", "INSERT INTO capital_commands (kind, requested_by) SELECT 'cancel', 'probe' WHERE false");
await reader.transaction([reader.query("SET TRANSACTION READ WRITE"), reader.query("INSERT INTO capital_commands (kind, requested_by) SELECT 'cancel', 'probe' WHERE false")]);
log("  ✓ INSERT capital_commands (read-write): allowed");
// …and read-write unlocks nothing else.
await expectDeniedReadWrite("INSERT", "INSERT INTO equity_snapshots (trading_date, equity, cash, long_market_value) SELECT current_date, 1, 1, 1 WHERE false");
await expectDeniedReadWrite("INSERT capital_command_results", "INSERT INTO capital_command_results (command_id, outcome) SELECT gen_random_uuid(), 'accepted' WHERE false");
await expectDeniedReadWrite("UPDATE risk_state", "UPDATE risk_state SET kill_switch = kill_switch WHERE false");
await expectDeniedReadWrite("UPDATE capital_commands", "UPDATE capital_commands SET kind = kind WHERE false");
await expectDeniedReadWrite("DELETE capital_commands", "DELETE FROM capital_commands WHERE false");
log(`${ROLE} ready.`);

if (process.argv.includes("--print-url")) process.stdout.write(roleUrl.toString());
