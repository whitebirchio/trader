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
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
export const APPEND_ONLY_TABLES = [
  "audit_events",
  "broker_activities",
  "risk_gate_runs",
  "risk_decisions",
  "strategies",
  "thesis_events",
  "rebalance_plans",
  "capital_flows",
  "capital_commands",
  "capital_command_results",
] as const;

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

/**
 * Daily adjusted closes of the benchmark (VTI), so readers without broker keys
 * (the dashboard) can chart against it. A cache of market data, not an action:
 * each after-close sync rewrites the whole window, so dividend adjustments to
 * past closes land too.
 */
export const benchmarkCloses = pgTable(
  "benchmark_closes",
  {
    symbol: text().notNull(),
    tradingDate: date({ mode: "string" }).notNull(),
    close: numeric().notNull(),
    recordedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.tradingDate] })],
);

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

// ---------------------------------------------------------------------------
// notifications (SPEC-notifications): an outbox of owner emails.
// ---------------------------------------------------------------------------

/**
 * Each email, queued before it's sent. `status`: pending → sending → sent, or
 * back to pending with backoff, or failed after 5 attempts; `suppressed` on
 * staging (only `test` emails send there). Not append-only: delivery updates it.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    type: text().notNull(),
    digestDate: date({ mode: "string" }).unique("notifications_digest_date_key"),
    subject: text().notNull(),
    text: text().notNull(),
    html: text().notNull(),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    claimedAt: timestamptz(),
    lastError: text(),
    messageId: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    sentAt: timestamptz(),
  },
  (t) => [index("notifications_due_idx").on(t.status, t.nextAttemptAt)],
);

/**
 * Which audit events each email covered: the at-most-once guarantee per
 * (event, type). `notificationId` is null for events folded into a later
 * email by throttling (repeated job failures).
 */
export const notificationItems = pgTable(
  "notification_items",
  {
    auditEventId: uuid()
      .notNull()
      .references(() => auditEvents.id),
    type: text().notNull(),
    notificationId: uuid().references(() => notifications.id),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.auditEventId, t.type] })],
);

// ---------------------------------------------------------------------------
// portfolio (SPEC-portfolio). All insert-only: the record of what was decided.
// ---------------------------------------------------------------------------

/** Every accepted strategy version. The highest version is active. Version 0 (hold VTI) is implicit. */
export const strategies = pgTable("strategies", {
  version: serial().primaryKey(),
  authoredBy: auditActor().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
  summary: text().notNull(),
  document: jsonb().$type<Record<string, unknown>>().notNull(),
});

/** Thesis lifecycle transitions. `stopped` is permanent: re-entry needs a new thesis id. */
export const thesisEvents = pgTable(
  "thesis_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    thesisId: text().notNull(),
    symbol: text().notNull(),
    kind: text().notNull(),
    strategyVersion: integer().notNull(),
    price: numeric(),
    averageCost: numeric(),
    reason: text().notNull(),
    at: timestamptz().notNull().defaultNow(),
  },
  (t) => [index("thesis_events_thesis_idx").on(t.thesisId, t.kind)],
);

/** One row per rebalance step: what it targeted, traded and skipped, and the risk run that gated it. */
export const rebalancePlans = pgTable(
  "rebalance_plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    tradingDate: date({ mode: "string" }).notNull(),
    strategyVersion: integer().notNull(),
    phase: text().notNull(),
    targets: jsonb().$type<unknown[]>().notNull(),
    trades: jsonb().$type<unknown[]>().notNull(),
    notes: jsonb().$type<string[]>().notNull(),
    gateRunId: uuid().references(() => riskGateRuns.id),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [index("rebalance_plans_date_idx").on(t.tradingDate)],
);

// ---------------------------------------------------------------------------
// capital (SPEC-capital.md): money moving in and out of the account.
// ---------------------------------------------------------------------------

/**
 * One row per external transfer (deposit, withdrawal, or a reversal of
 * either), copied from broker_activities. The single source of flows for the
 * risk index, the VTI comparison and every surface. `at` is the instant the
 * money moved (Alpaca's created_at); `timed_by = booking_date` marks the rare
 * activity without one, timed at noon ET on its booking date. Append-only:
 * a withdrawal request links to its flows from its own side.
 */
export const capitalFlows = pgTable(
  "capital_flows",
  {
    activityId: text()
      .primaryKey()
      .references(() => brokerActivities.id),
    at: timestamptz().notNull(),
    /** Signed: positive into the account, negative out. */
    amount: numeric().notNull(),
    kind: text({ enum: ["deposit", "withdrawal", "reversal"] }).notNull(),
    timedBy: text({ enum: ["created_at", "booking_date"] }).notNull(),
    /** Alpaca's activity status (executed, correct, canceled), when given. */
    status: text(),
    recordedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index("capital_flows_at_idx").on(t.at),
    check("capital_flows_kind", sql`${t.kind} in ('deposit', 'withdrawal', 'reversal')`),
    check("capital_flows_timed_by", sql`${t.timedBy} in ('created_at', 'booking_date')`),
  ],
);

/**
 * Owner commands about withdrawals: what the dashboard (its one INSERT
 * grant) and the capital:* CLI write. Append-only. The engine processes each
 * once, on its next tick, and records the outcome in capital_command_results;
 * `amount` stays text so a bad value is rejected and audited, never guessed.
 */
export const capitalCommands = pgTable(
  "capital_commands",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text({ enum: ["request", "cancel", "fund_now"] }).notNull(),
    /** A request's dollars ("500" or "500.25"), or "all". */
    amount: text(),
    /** Who asked: "cli" or "dashboard:<email>". */
    requestedBy: text().notNull(),
    at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index("capital_commands_at_idx").on(t.at),
    check("capital_commands_kind", sql`${t.kind} in ('request', 'cancel', 'fund_now')`),
  ],
);

/** One row per processed command: the at-most-once record. Append-only. */
export const capitalCommandResults = pgTable("capital_command_results", {
  commandId: uuid()
    .primaryKey()
    .references(() => capitalCommands.id),
  outcome: text({ enum: ["accepted", "rejected"] }).notNull(),
  /** Why it was rejected: email-ready. */
  reason: text(),
  withdrawalId: uuid(),
  processedAt: timestamptz().notNull().defaultNow(),
});

/**
 * Withdrawal requests (SPEC-capital): mutable state, like orders. Every
 * transition is audited. At most one is open (a partial unique index).
 * `requested` is the command waiting for the engine, so a row starts in
 * `planning`.
 */
export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid().primaryKey().defaultRandom(),
    status: text({ enum: ["planning", "funding", "settling", "ready", "withdrawn", "cancelled"] }).notNull(),
    /** Dollars requested; null = everything in the account. */
    amount: numeric(),
    /** Outgoing transfers matched to it so far (positive dollars). */
    withdrawn: numeric().notNull().default("0"),
    /** The capital_flows rows matched to it. */
    flowIds: jsonb().$type<string[]>().notNull().default([]),
    commandId: uuid()
      .notNull()
      .references(() => capitalCommands.id),
    requestedAt: timestamptz().notNull(),
    /** When Claude's window to plan the funding closes and the fallback runs. */
    deadline: timestamptz().notNull(),
    /** The strategy version that funds it, and who wrote it. */
    fundingVersion: integer(),
    fundedBy: auditActor(),
    updatedAt: timestamptz().notNull(),
    closedAt: timestamptz(),
  },
  (t) => [
    uniqueIndex("withdrawals_one_open").on(sql`(true)`).where(sql`${t.status} not in ('withdrawn', 'cancelled')`),
    check("withdrawals_status", sql`${t.status} in ('planning', 'funding', 'settling', 'ready', 'withdrawn', 'cancelled')`),
  ],
);
