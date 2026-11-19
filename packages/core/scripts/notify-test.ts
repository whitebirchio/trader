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
import { footerLine } from "../src/notifications/compose.js";
import { render } from "../src/notifications/layout.js";
import type { OutgoingEmail } from "../src/notifications/port.js";
import { EMAIL_SAMPLES } from "../src/notifications/samples.js";
import { enqueue } from "../src/notifications/outbox.js";
import { formatMarketTime } from "../src/time.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" }, sample: { type: "string" } } });

await withOps(values.env, async ({ env, db }) => {
  const now = new Date();
  const label = env === "staging" ? "[paper] " : "";
  const body = `This is a test email from Trader${env === "staging" ? " (staging)" : ""}. If you're reading it, the outbox, SES and the notify-urgent job all work.`;
  const emails: OutgoingEmail[] = values.sample
    ? (values.sample === "all" ? Object.keys(EMAIL_SAMPLES) : [values.sample]).map((name) => {
        const sample = EMAIL_SAMPLES[name];
        if (!sample) throw new Error(`unknown sample "${name}"; try: all, ${Object.keys(EMAIL_SAMPLES).join(", ")}`);
        const email = sample(env, now);
        return { ...email, subject: `${label}[sample] ${email.subject.replace(label, "")}` };
      })
    : [{ subject: `${label}Trader: test email`, ...render({ preheader: body, title: "Test email", blocks: [{ type: "paragraph", text: body }], footer: footerLine(env, now) }) }];
  const next = new Date(Math.ceil(now.getTime() / (15 * 60_000)) * 15 * 60_000);
  for (const email of emails) {
    const result = await enqueue(db, env, { type: "test", email, eventIds: [] }, now);
    if (result.status !== "queued") throw new Error("test email was not queued");
    console.log(`Queued "${email.subject}" (${result.notification.id}) on ${env}; it sends on the next tick (~${formatMarketTime(next)}).`);
  }
});
