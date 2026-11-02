import { parseAmount } from "@trader/core";
import { sessionEmail } from "./auth";
import type { DashboardConfig } from "./config";
import { CSRF_TTL_S, sign, verify } from "./session";

/**
 * The dashboard's one write (SPEC-capital, ADR-015): queue a withdrawal
 * command for the engine, which validates and applies it on its next tick
 * and emails the owner. Kept free of Next and the database so every check is
 * tested. Money can't leave through here: the ACH happens in Alpaca.
 */

export const COMMAND_KINDS = ["request", "cancel", "fund_now"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export interface NewCommand {
  kind: CommandKind;
  /** A request's dollars, or "all"; null for cancel and fund_now. */
  amount: string | null;
  requestedBy: string;
}

export type CommandResponse = { status: 303; location: string } | { status: 400 | 401 | 403; message: string };

export interface CommandRequest {
  config: DashboardConfig;
  sessionToken: string | undefined;
  /** The request's Origin header. A browser always sends it on a POST; its absence fails closed. */
  origin: string | null;
  form: FormData;
  nowS: number;
}

/** The anti-forgery token every write form carries. */
export function csrfToken(config: DashboardConfig, email: string, nowS: number): Promise<string> {
  return sign({ t: "csrf", email, exp: nowS + CSRF_TTL_S }, config.sessionKey);
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : null;
};

/** Check everything, then insert. Each refusal says what to do, never echoes a secret. */
export async function handleCommandPost(req: CommandRequest, insert: (command: NewCommand) => Promise<string>): Promise<CommandResponse> {
  const email = await sessionEmail(req.config, req.sessionToken, req.nowS);
  if (!email) return { status: 401, message: "Sign in again, then retry." };
  if (req.origin !== req.config.baseUrl) return { status: 403, message: "Refused: the request didn't come from the dashboard." };
  const csrf = await verify(field(req.form, "csrf") ?? undefined, req.config.sessionKey, "csrf", req.nowS);
  if (!csrf || csrf.email !== email) return { status: 403, message: "This form has expired. Go back to the Money page and try again." };

  const kind = field(req.form, "kind");
  if (!kind || !(COMMAND_KINDS as readonly string[]).includes(kind)) return { status: 400, message: "Unknown command." };
  if (field(req.form, "confirm") !== "yes") return { status: 400, message: "Confirm the command first." };

  let amount: string | null = null;
  if (kind === "request") {
    const parsed = parseAmount(field(req.form, "amount"));
    if (!parsed.ok) return { status: 400, message: `Not sent: ${parsed.reason}.` };
    amount = parsed.amount ?? "all";
  }
  await insert({ kind: kind as CommandKind, amount, requestedBy: `dashboard:${email}` });
  return { status: 303, location: `${req.config.baseUrl}/money?sent=${kind}` };
}
