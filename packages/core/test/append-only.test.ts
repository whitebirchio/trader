import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { APPEND_ONLY_TABLES } from "../src/db/schema.js";
import { createTestDb } from "./helpers.js";

let pglite: PGlite;

beforeEach(async () => {
  ({ pglite } = await createTestDb());
  await pglite.exec(`
    INSERT INTO audit_events (actor, kind) VALUES ('system', 'job.failed');
    INSERT INTO broker_activities (id, type, at, raw) VALUES ('a-1', 'DIV', now(), '{}');
    INSERT INTO risk_gate_runs (id, limits_version, snapshot) VALUES ('00000000-0000-0000-0000-000000000001', 'v', '{}');
    INSERT INTO risk_decisions (gate_run_id, intent_key, symbol, side, sleeve, verdict, reasons, limits_version)
      VALUES ('00000000-0000-0000-0000-000000000001', 'k', 'VTI', 'buy', 'systematic', 'approved', '[]', 'v');
    INSERT INTO strategies (authored_by, summary, document) VALUES ('owner', 's', '{}');
    INSERT INTO thesis_events (thesis_id, symbol, kind, strategy_version, reason) VALUES ('t', 'AAPL', 'stopped', 1, 'r');
    INSERT INTO rebalance_plans (trading_date, strategy_version, phase, targets, trades, notes) VALUES ('2026-11-02', 0, 'none', '[]', '[]', '[]');
    INSERT INTO broker_activities (id, type, at, net_amount, raw) VALUES ('csd-1', 'CSD', now(), 1000, '{}');
    INSERT INTO capital_flows (activity_id, at, amount, kind, timed_by) VALUES ('csd-1', now(), 1000, 'deposit', 'booking_date');
  `);
});

describe.each(APPEND_ONLY_TABLES)("%s is append-only (ADR-008)", (table) => {
  it("rejects UPDATE", async () => {
    const col = table === "strategies" ? "version" : table === "capital_flows" ? "activity_id" : "id";
    await expect(pglite.exec(`UPDATE ${table} SET ${col} = ${col}`)).rejects.toThrow(/append-only/);
  });
  it("rejects DELETE", async () => {
    await expect(pglite.exec(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
  });
  it("rejects TRUNCATE", async () => {
    await expect(pglite.exec(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
  });
});
