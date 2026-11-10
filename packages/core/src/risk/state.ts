import { and, eq, isNull, ne, or } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { Db } from "../db/client.js";
import { riskState } from "../db/schema.js";

export type RiskStateRow = typeof riskState.$inferSelect;

/**
 * Owner commands take `actor: "owner"` as a literal type, so no code path can
 * pass `"claude"` or `"system"` to them (ADR-012). The MCP layer (`agent`) must
 * only expose them to an owner-authenticated caller.
 */
export interface OwnerAction {
  actor: "owner";
  reason: string;
}

/** The single risk_state row (seeded by migration 0005). Throws if it's missing: fail closed. */
export async function getRiskState(db: Db): Promise<RiskStateRow> {
  const row = (await db.select().from(riskState).where(eq(riskState.id, 1)))[0];
  if (!row) throw new Error("risk_state row is missing; run migrations (fail closed)");
  return row;
}

/** Turn the kill switch on. Only `resume` turns it off. */
export async function setKillSwitch(db: Db, action: OwnerAction, now: Date): Promise<{ status: "on" | "already_on" }> {
  const changed = await db
    .update(riskState)
    .set({ killSwitch: true, killReason: action.reason, updatedAt: now, updatedBy: "owner" })
    .where(and(eq(riskState.id, 1), eq(riskState.killSwitch, false)))
    .returning({ id: riskState.id });
  if (changed.length === 0) return { status: "already_on" };
  await recordEvent(db, { actor: "owner", kind: "risk.kill_switch_on", payload: { reason: action.reason } });
  return { status: "on" };
}

/**
 * Latch the drawdown halt. Conditional on not already being halted, so two
 * overlapping syncs trip and audit it once. Never clears itself.
 */
export async function latchHalt(
  db: Db,
  reason: string,
  detail: Record<string, unknown>,
  now: Date,
): Promise<{ status: "halted" | "already_halted" }> {
  const changed = await db
    .update(riskState)
    .set({ halted: true, haltReason: reason, haltedAt: now, updatedAt: now, updatedBy: "system" })
    .where(and(eq(riskState.id, 1), eq(riskState.halted, false)))
    .returning({ id: riskState.id });
  if (changed.length === 0) return { status: "already_halted" };
  await recordEvent(db, { actor: "system", kind: "risk.halted", payload: { reason, ...detail } });
  return { status: "halted" };
}

/** Clear the kill switch and/or the halt. Owner only. */
export async function resume(
  db: Db,
  action: OwnerAction,
  now: Date,
): Promise<{ status: "resumed"; cleared: string[] } | { status: "nothing_to_resume" }> {
  const before = await getRiskState(db);
  const cleared = [
    ...(before.killSwitch ? [`kill switch (${before.killReason ?? "no reason given"})`] : []),
    ...(before.halted ? [`halt (${before.haltReason ?? "no reason given"})`] : []),
  ];
  if (cleared.length === 0) return { status: "nothing_to_resume" };
  await db
    .update(riskState)
    // Clearing a halt re-bases the drawdown (ADR-017); clearing only the kill switch doesn't.
    .set({ killSwitch: false, killReason: null, halted: false, haltReason: null, haltedAt: null, ...(before.halted ? { resumedAt: now } : {}), updatedAt: now, updatedBy: "owner" })
    .where(eq(riskState.id, 1));
  await recordEvent(db, { actor: "owner", kind: "risk.resumed", payload: { reason: action.reason, cleared } });
  return { status: "resumed", cleared };
}

/**
 * Record a daily-loss pause transition for `marketDate`, audited once per day
 * in each direction. The pause itself is enforced from the live index at
 * evaluation time; this only drives the announcement.
 */
export async function markBuysPaused(
  db: Db,
  paused: boolean,
  marketDate: string,
  detail: Record<string, unknown>,
  now: Date,
): Promise<boolean> {
  const changed = paused
    ? await db
        .update(riskState)
        .set({ buysPausedOn: marketDate, updatedAt: now })
        .where(and(eq(riskState.id, 1), or(isNull(riskState.buysPausedOn), ne(riskState.buysPausedOn, marketDate))))
        .returning({ id: riskState.id })
    : await db
        .update(riskState)
        .set({ buysPausedOn: null, updatedAt: now })
        .where(and(eq(riskState.id, 1), eq(riskState.buysPausedOn, marketDate)))
        .returning({ id: riskState.id });
  if (changed.length === 0) return false;
  await recordEvent(db, { actor: "system", kind: paused ? "risk.buys_paused" : "risk.buys_resumed", payload: { marketDate, ...detail } });
  return true;
}
