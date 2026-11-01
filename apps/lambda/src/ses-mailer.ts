import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import type { Mailer, OutgoingEmail } from "@trader/core";

/**
 * The core Mailer port over SES (SPEC-platform-aws). The account stays in the
 * SES sandbox and the IAM policy pins the from-address, so this can only ever
 * email the verified owner address.
 */
export class SesMailer implements Mailer {
  constructor(
    private readonly ses: SESv2Client,
    private readonly from: string,
    private readonly to: string,
  ) {}

  async send(email: OutgoingEmail): Promise<{ messageId: string }> {
    const result = await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: `Trader <${this.from}>`,
        Destination: { ToAddresses: [this.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: { Text: { Data: email.text, Charset: "UTF-8" }, Html: { Data: email.html, Charset: "UTF-8" } },
          },
        },
      }),
    );
    if (!result.MessageId) throw new Error("SES returned no MessageId");
    return { messageId: result.MessageId };
  }
}
