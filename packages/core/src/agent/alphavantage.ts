/**
 * What every Alpha Vantage JSON reply has in common (#105): a refusal comes
 * back as HTTP 200 with a notice instead of data. "Information" or "Note"
 * holds it, for the daily limit or for going faster than one request a
 * second. The per-second notice also mentions the daily limit, so it's told
 * apart by its own wording.
 */
export type Refusal = { status: "limited"; perSecond: boolean; note: string };

export function readReply(body: string, what: string): { json: Record<string, unknown> } | { refused: Refusal } {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`Alpha Vantage returned unreadable ${what}`);
  }
  const note = json.Information ?? json.Note;
  if (note !== undefined) return { refused: { status: "limited", perSecond: /per second|sparingly/i.test(String(note)), note: String(note) } };
  return { json };
}
