import type { Mailer, OutgoingEmail } from "../../src/notifications/port.js";

/** Records sends; `failNext` makes the next N sends throw. */
export class FakeMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  failNext = 0;

  async send(email: OutgoingEmail): Promise<{ messageId: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("smtp down");
    }
    this.sent.push(email);
    return { messageId: `msg-${this.sent.length}` };
  }
}
