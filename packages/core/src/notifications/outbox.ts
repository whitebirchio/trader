import { and, eq, inArray, lt, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notificationItems, notifications } from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import type { Mailer, OutgoingEmail } from "./port.js";

export type NotificationType = "urgent" | "digest" | "weekly" | "test";
export type NotificationRow = typeof notifications.$inferSelect;

/** Retry delays after a failed send; after the last one the email is `failed`. */
export const BACKOFF_MINUTES = [1, 5, 15, 60] as const;
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** A `sending` row older than this belongs to a run that died mid-send. */
export const STALE_CLAIM_MS = 10 * 60_000;

export type EnqueueResult =
  | { status: "queued"; notification: NotificationRow }
  | { status: "duplicate" };

class Duplicate extends Error {}

/**
 * Queue an email covering `eventIds`. Idempotent: an event already covered for
 * this type, or a digest date or letter week that already has an email, gives `duplicate` and
 * writes nothing. On staging everything except `test` is written `suppressed`
 * (SPEC-notifications resolved question 2): same path, no send.
 */
export async function enqueue(
  db: Db,
  env: TradingEnv,
  input: { type: NotificationType; email: OutgoingEmail; eventIds: string[]; digestDate?: string; weekOf?: string },
  now: Date,
): Promise<EnqueueResult> {
  const status = env === "staging" && input.type !== "test" ? "suppressed" : "pending";
  try {
    const row = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(notifications)
        .values({
          type: input.type,
          digestDate: input.digestDate ?? null,
          weekOf: input.weekOf ?? null,
          subject: input.email.subject,
          text: input.email.text,
          html: input.email.html,
          status,
          nextAttemptAt: now,
          createdAt: now,
        })
        // Either unique key (digest date, letter week) makes it a duplicate.
        .onConflictDoNothing()
        .returning();
      const notification = inserted[0];
      if (!notification) throw new Duplicate();
      if (input.eventIds.length > 0) {
        const covered = await tx
          .insert(notificationItems)
          .values(input.eventIds.map((auditEventId) => ({ auditEventId, type: input.type, notificationId: notification.id, createdAt: now })))
          .onConflictDoNothing()
          .returning({ id: notificationItems.auditEventId });
        // Another run covered some of these events first: back out entirely.
        if (covered.length < input.eventIds.length) throw new Duplicate();
      }
      return notification;
    });
    return { status: "queued", notification: row };
  } catch (e) {
    if (e instanceof Duplicate) return { status: "duplicate" };
    throw e;
  }
}

/** Mark events as handled without an email of their own (throttled repeats). */
export async function foldEvents(db: Db, type: NotificationType, eventIds: string[], now: Date): Promise<void> {
  if (eventIds.length === 0) return;
  await db
    .insert(notificationItems)
    .values(eventIds.map((auditEventId) => ({ auditEventId, type, notificationId: null, createdAt: now })))
    .onConflictDoNothing();
}

export interface DeliveryReport {
  sent: number;
  retrying: number;
  failed: number;
}

/**
 * Send every due email. Each is claimed with a conditional update first, so
 * overlapping runs send it once. A run that dies after claiming leaves the row
 * `sending`; it's retried once stale, so the worst case is a duplicate email,
 * never a lost one.
 */
export async function deliver(db: Db, mailer: Mailer, now: Date): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, retrying: 0, failed: 0 };
  const due = await db
    .select()
    .from(notifications)
    .where(
      or(
        and(eq(notifications.status, "pending"), lte(notifications.nextAttemptAt, now)),
        and(eq(notifications.status, "sending"), lt(notifications.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
      ),
    )
    .orderBy(notifications.createdAt);

  for (const row of due) {
    const claimed = await db
      .update(notifications)
      .set({ status: "sending", claimedAt: now })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, row.status), row.claimedAt ? eq(notifications.claimedAt, row.claimedAt) : undefined))
      .returning({ id: notifications.id });
    if (claimed.length === 0) continue;

    try {
      const { messageId } = await mailer.send({ subject: row.subject, text: row.text, html: row.html });
      await db.update(notifications).set({ status: "sent", messageId, sentAt: now, lastError: null }).where(eq(notifications.id, row.id));
      report.sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      const delay = BACKOFF_MINUTES[attempts - 1];
      if (delay === undefined) {
        await db.update(notifications).set({ status: "failed", attempts, lastError: error }).where(eq(notifications.id, row.id));
        report.failed++;
      } else {
        await db
          .update(notifications)
          .set({ status: "pending", attempts, lastError: error, nextAttemptAt: new Date(now.getTime() + delay * 60_000) })
          .where(eq(notifications.id, row.id));
        report.retrying++;
      }
    }
  }
  return report;
}

/** Events of these ids already covered (emailed or folded) for `type`. */
export async function coveredEventIds(db: Db, type: NotificationType, eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const rows = await db
    .select({ id: notificationItems.auditEventId })
    .from(notificationItems)
    .where(and(eq(notificationItems.type, type), inArray(notificationItems.auditEventId, eventIds)));
  return new Set(rows.map((r) => r.id));
}
