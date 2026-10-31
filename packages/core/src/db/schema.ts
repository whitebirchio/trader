/**
 * Trader data model. Why it is shaped this way: docs/decisions/ (notably
 * ADR-007 idempotent job runs, ADR-008 append-only audit log, ADR-009 money).
 *
 * Conventions:
 * - Column property names are camelCase; the DB uses snake_case via drizzle's
 *   `casing: "snake_case"` option (must be set in BOTH drizzle.config.ts and
 *   every runtime drizzle() call).
 * - Timestamps are UTC timestamptz. Money and quantities are `numeric`, read
 *   and written as decimal strings (ADR-009).
 * - No accounts table: one Alpaca account per environment (ADR-005).
 * - Migrations are additive only — merging to main applies them to production
 *   (ADR-006).
 */
import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const jobStatus = pgEnum("job_status", ["running", "succeeded", "failed", "skipped"]);
export const auditActor = pgEnum("audit_actor", ["system", "claude", "owner"]);

const timestamptz = (name?: string) =>
  name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true });

/** One row per (job, scheduled time). The unique key is the idempotency claim (ADR-007). */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    job: text().notNull(),
    scheduledFor: timestamptz().notNull(),
    startedAt: timestamptz().notNull().defaultNow(),
    finishedAt: timestamptz(),
    status: jobStatus().notNull(),
    error: text(),
    detail: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [
    unique("job_runs_job_scheduled_for_key").on(t.job, t.scheduledFor),
    index("job_runs_job_status_scheduled_idx").on(t.job, t.status, desc(t.scheduledFor)),
  ],
);

/** Append-only: a trigger rejects UPDATE/DELETE and trader_app has no such grant (ADR-008). */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    at: timestamptz().notNull().defaultNow(),
    actor: auditActor().notNull(),
    kind: text().notNull(),
    subject: text(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    jobRunId: uuid().references(() => jobRuns.id),
  },
  (t) => [
    index("audit_events_at_idx").on(desc(t.at)),
    index("audit_events_kind_at_idx").on(t.kind, desc(t.at)),
  ],
);

/**
 * Tables the Worker may only INSERT into (ADR-008). Each has a reject-mutation
 * trigger in a migration, and scripts/app-role.ts revokes UPDATE/DELETE/TRUNCATE
 * on each from trader_app. Add new append-only tables here.
 */
export const APPEND_ONLY_TABLES = ["audit_events", "broker_activities", "risk_gate_runs", "risk_decisions"] as const;

// ---------------------------------------------------------------------------
// broker (SPEC-broker.md). Money and quantities are numeric (ADR-009).
// ---------------------------------------------------------------------------

/**
 * Single row: the pinned account and its last-synced state. `tradingAllowed`
 * is the verdict `risk` requires; `blockedReasons` explains a false.
 */
export const brokerAccount = pgTable(
  "broker_account",
  {
    id: integer().primaryKey().default(1),
    accountNumber: text().notNull(),
    status: text().notNull(),
    cash: numeric().notNull(),
    equity: numeric().notNull(),
    /** Alpaca's equity at the prior close: the base for risk's daily-loss check. */
    lastEquity: numeric(),
    longMarketValue: numeric().notNull(),
    buyingPower: numeric().notNull(),
    multiplier: text().notNull(),
    tradingBlocked: boolean().notNull(),
    accountBlocked: boolean().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull(),
    tradingAllowed: boolean().notNull().default(false),
    blockedReasons: jsonb().$type<string[]>().notNull().default([]),
    syncedAt: timestamptz().notNull(),
  },
  (t) => [check("broker_account_singleton", sql`${t.id} = 1`)],
);

/** Every Alpaca account activity, keyed by Alpaca's id. Insert-only; lots derive from it. */
export const brokerActivities = pgTable(
  "broker_activities",
  {
    id: text().primaryKey(),
    type: text().notNull(),
    at: timestamptz().notNull(),
    symbol: text(),
    side: text(),
    qty: numeric(),
    price: numeric(),
    netAmount: numeric(),
    orderId: text(),
    raw: jsonb().$type<Record<string, unknown>>().notNull(),
    syncedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index("broker_activities_type_at_idx").on(t.type, t.at),
    index("broker_activities_symbol_idx").on(t.symbol),
  ],
);

/**
 * Our order intents plus Alpaca's view of them. `status` is our own
 * `intent | unknown | not_found` or Alpaca's status string. Orders placed
 * outside the system (e.g. the Alpaca app) are recorded with no intent_key.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    clientOrderId: text().notNull().unique("orders_client_order_id_key"),
    intentKey: text(),
    strategyRef: text(),
    symbol: text().notNull(),
    side: text().notNull(),
    notional: numeric(),
    qty: numeric(),
    status: text().notNull(),
    brokerOrderId: text().unique("orders_broker_order_id_key"),
    filledQty: numeric(),
    filledAvgPrice: numeric(),
    rejectReason: text(),
    submittedAt: timestamptz(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
    raw: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [index("orders_status_idx").on(t.status)],
);

/** Cache of Alpaca's positions, replaced on every sync. Alpaca is the source of truth. */
export const positions = pgTable("positions", {
  symbol: text().primaryKey(),
  qty: numeric().notNull(),
  avgEntryPrice: numeric().notNull(),
  marketValue: numeric().notNull(),
  costBasis: numeric().notNull(),
  currentPrice: numeric().notNull(),
  syncedAt: timestamptz().notNull(),
});

/** One row per trading day, written by the first sync after the close. */
export const equitySnapshots = pgTable("equity_snapshots", {
  tradingDate: date({ mode: "string" }).primaryKey(),
  equity: numeric().notNull(),
  cash: numeric().notNull(),
  longMarketValue: numeric().notNull(),
  recordedAt: timestamptz().notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// risk (SPEC-risk). Limits are code (src/risk/limits.ts); this is runtime state.
// ---------------------------------------------------------------------------

/**
 * Single row (seeded by migration). The kill switch and the drawdown halt are
 * latched: only an owner command clears them (ADR-012). `buysPausedOn` records
 * the market date a daily-loss pause was announced, so it's audited once.
 */
export const riskState = pgTable(
  "risk_state",
  {
    id: integer().primaryKey().default(1),
    killSwitch: boolean().notNull().default(false),
    killReason: text(),
    halted: boolean().notNull().default(false),
    haltReason: text(),
    haltedAt: timestamptz(),
    buysPausedOn: date({ mode: "string" }),
    updatedAt: timestamptz().notNull().defaultNow(),
    updatedBy: auditActor().notNull().default("system"),
  },
  (t) => [check("risk_state_singleton", sql`${t.id} = 1`)],
);

/** One row per riskGate call, with the exact snapshot it evaluated. Insert-only. */
export const riskGateRuns = pgTable("risk_gate_runs", {
  id: uuid().primaryKey().defaultRandom(),
  ranAt: timestamptz().notNull().defaultNow(),
  limitsVersion: text().notNull(),
  snapshot: jsonb().$type<Record<string, unknown>>().notNull(),
});

/** One row per evaluated proposal. Insert-only. */
export const riskDecisions = pgTable(
  "risk_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    gateRunId: uuid()
      .notNull()
      .references(() => riskGateRuns.id),
    intentKey: text().notNull(),
    symbol: text().notNull(),
    side: text().notNull(),
    sleeve: text().notNull(),
    requestedNotional: numeric(),
    requestedQty: numeric(),
    approvedNotional: numeric(),
    approvedQty: numeric(),
    verdict: text().notNull(),
    reasons: jsonb().$type<string[]>().notNull(),
    limitsVersion: text().notNull(),
    decidedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [index("risk_decisions_intent_idx").on(t.intentKey), index("risk_decisions_run_idx").on(t.gateRunId)],
);
