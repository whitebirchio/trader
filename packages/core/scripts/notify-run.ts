/**
 * Run notify-urgent's queueing step now, instead of waiting for the next tick:
 * picks up un-emailed urgent events and queues the email (suppressed on
 * paper). Sending stays with the Worker's next tick, since only it holds the
 * send_email binding. Safe to run alongside the cron: queueing is idempotent.
 *
 *   npm run notify:run -w @trader/core -- --env production
 */
import { parseArgs } from "node:util";
import { desc, gte } from "drizzle-orm";
import { notifications } from "../src/db/schema.js";
import { queueUrgent } from "../src/notifications/jobs.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });

await withOps(values.env, async ({ env, db }) => {
  const now = new Date();
  const result = await queueUrgent(db, env, now);
  console.log(`${env}: ${result.events} urgent event(s), ${result.folded} folded, ${result.queued ? "email queued" : "nothing queued"}.`);
  for (const r of await db.select().from(notifications).where(gte(notifications.createdAt, now)).orderBy(desc(notifications.createdAt))) {
    console.log(`  ${r.type} · ${r.status} · ${r.subject}`);
  }
});
