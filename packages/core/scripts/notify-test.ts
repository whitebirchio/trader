/**
 * Queue a test email through the outbox; the environment's next tick sends it
 * via the real `send_email` binding. Test emails are the only kind staging
 * actually sends (SPEC-notifications).
 *
 *   npm run notify:test -w @trader/core -- --env production|paper [--sample <name>|all]
 *
 * --sample queues the named sample emails (src/notifications/samples.ts)
 * instead, subjects prefixed "[sample]", to see the real thing in Gmail.
 */
import { parseArgs } from "node:util";
import { composeUrgent, escapeHtml, footer } from "../src/notifications/compose.js";
import type { OutgoingEmail } from "../src/notifications/port.js";
import { SAMPLES } from "../src/notifications/samples.js";
import { enqueue } from "../src/notifications/outbox.js";
import { formatMarketTime } from "../src/time.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, sample: { type: "string" } } });

await withOps(values.env, async ({ env, db }) => {
  const now = new Date();
  const label = env === "staging" ? "[paper] " : "";
  const body = `This is a test email from Trader${env === "staging" ? " (staging)" : ""}. If you're reading it, the outbox, SES and the notify-urgent job all work.`;
  const f = footer(env, now);
  const emails: OutgoingEmail[] = values.sample
    ? (values.sample === "all" ? Object.keys(SAMPLES) : [values.sample]).map((name) => {
        const sample = SAMPLES[name];
        if (!sample) throw new Error(`unknown sample "${name}"; try: all, ${Object.keys(SAMPLES).join(", ")}`);
        const email = composeUrgent(sample(), env, now);
        return { ...email, subject: `${label}[sample] ${email.subject.replace(label, "")}` };
      })
    : [{ subject: `${label}Trader: test email`, text: `${body}${f.text}`, html: `<p>${escapeHtml(body)}</p>${f.html}` }];
  const next = new Date(Math.ceil(now.getTime() / (15 * 60_000)) * 15 * 60_000);
  for (const email of emails) {
    const result = await enqueue(db, env, { type: "test", email, eventIds: [] }, now);
    if (result.status !== "queued") throw new Error("test email was not queued");
    console.log(`Queued "${email.subject}" (${result.notification.id}) on ${env}; it sends on the next tick (~${formatMarketTime(next)}).`);
  }
});
