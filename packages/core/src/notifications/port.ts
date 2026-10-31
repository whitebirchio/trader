/**
 * The mail port (ADR-002). The engine adapts Cloudflare's `send_email` binding
 * to it; tests and scripts use fakes. Every Trader email goes to the owner's
 * verified address, so there is no recipient field: the adapter supplies it.
 */
export interface OutgoingEmail {
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Resolves with the provider's message id; throws on failure. */
  send(email: OutgoingEmail): Promise<{ messageId: string }>;
}
