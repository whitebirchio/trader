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
import { desc } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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
