import type { Mailer, OutgoingEmail } from "@trader/core";

/**
 * The core Mailer port over Cloudflare's `send_email` binding. The binding is
 * restricted to the owner's verified address (wrangler.jsonc), which keeps
 * this on the free Email Routing path and means it can't email anyone else.
 */
export class CloudflareMailer implements Mailer {
  constructor(
    private readonly binding: SendEmail,
    private readonly from: string,
    private readonly to: string,
  ) {}

  async send(email: OutgoingEmail): Promise<{ messageId: string }> {
    const result = await this.binding.send({
      from: { name: "Trader", email: this.from },
      to: this.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    return { messageId: result.messageId };
  }
}
