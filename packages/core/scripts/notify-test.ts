/**
 * Queue a test email through the outbox; the environment's next tick sends it
 * via the real `send_email` binding. Test emails are the only kind staging
 * actually sends (SPEC-notifications).
 *
 *   npm run notify:test -w @trader/core -- --env staging|production
 */
import { parseArgs } from "node:util";
import { escapeHtml, footer } from "../src/notifications/compose.js";
import { enqueue } from "../src/notifications/outbox.js";
import { formatMarketTime } from "../src/time.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });

await withOps(values.env, async ({ env, db }) => {
  const now = new Date();
  const label = env === "staging" ? "[paper] " : "";
  const body = `This is a test email from Trader${env === "staging" ? " (staging)" : ""}. If you're reading it, the outbox, SES and the notify-urgent job all work.`;
  const f = footer(env, now);
  const result = await enqueue(
    db,
    env,
    { type: "test", email: { subject: `${label}Trader: test email`, text: `${body}${f.text}`, html: `<p>${escapeHtml(body)}</p>${f.html}` }, eventIds: [] },
    now,
  );
  if (result.status !== "queued") throw new Error("test email was not queued");
  const next = new Date(Math.ceil(now.getTime() / (15 * 60_000)) * 15 * 60_000);
  console.log(`Queued test email ${result.notification.id} on ${env}; it sends on the next tick (~${formatMarketTime(next)}).`);
});
