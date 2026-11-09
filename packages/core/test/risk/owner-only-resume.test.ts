import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { getRiskState, resume } from "../../src/risk/state.js";
import { createTestDb } from "../helpers.js";

// The database enforces ADR-012 (migration 0021): only the role that owns
// risk_state (the owner, which risk:resume connects as) can clear the kill
// switch or a halt, or delete the row. PGlite's default role created the
// tables, so it plays the owner; trader_app plays the engine.
let pglite: PGlite;
let db: Db;

beforeEach(async () => {
  ({ pglite, db } = await createTestDb());
  await pglite.exec(`
    CREATE ROLE trader_app NOLOGIN;
    -- TRUNCATE too (trader_app lacks it in production), so the trigger itself is what refuses it.
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON risk_state TO trader_app;
    UPDATE risk_state SET halted = true, halt_reason = 'drawdown', kill_switch = true, kill_reason = 'test';
  `);
});

const asApp = async (sql: string) => {
  await pglite.exec("SET ROLE trader_app");
  try {
    await pglite.exec(sql);
  } finally {
    await pglite.exec("RESET ROLE");
  }
};

describe("risk_state: only the owner resumes (ADR-012)", () => {
  it("refuses another role clearing a halt or the kill switch, deleting or truncating the row", async () => {
    await expect(asApp("UPDATE risk_state SET halted = false")).rejects.toThrow(/only the owner can clear/);
    await expect(asApp("UPDATE risk_state SET kill_switch = false")).rejects.toThrow(/only the owner can clear/);
    await expect(asApp("DELETE FROM risk_state")).rejects.toThrow(/only the owner can DELETE/);
    await expect(asApp("TRUNCATE risk_state")).rejects.toThrow(/only the owner can TRUNCATE/);
    expect(await getRiskState(db)).toMatchObject({ halted: true, killSwitch: true });
  });

  it("lets another role turn them on, and change everything else", async () => {
    await pglite.exec("UPDATE risk_state SET halted = false, kill_switch = false");
    await asApp("UPDATE risk_state SET halted = true, halt_reason = 'drawdown 31%'");
    await asApp("UPDATE risk_state SET kill_switch = true, kill_reason = 'engine'");
    await asApp("UPDATE risk_state SET buys_paused_on = '2026-11-09'");
    expect(await getRiskState(db)).toMatchObject({ halted: true, killSwitch: true, buysPausedOn: "2026-11-09" });
  });

  it("lets the owner resume", async () => {
    expect(await resume(db, { actor: "owner", reason: "reviewed" }, new Date("2026-11-09T14:00:00Z"))).toMatchObject({ status: "resumed" });
    expect(await getRiskState(db)).toMatchObject({ halted: false, killSwitch: false });
  });
});
