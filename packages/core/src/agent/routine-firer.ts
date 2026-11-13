/**
 * Start a research run through the routines API (SPEC-agent § Missed-run
 * recovery): `check-routine` re-fires a slot whose run submitted nothing, and
 * `routine:fire` fires one by hand. Each routine has its own token, made by
 * the owner in the routine's settings on claude.ai; a token can only fire that
 * routine. The API is in research preview, so every failure is a result the
 * caller reports, never a throw, and no result or error carries the token.
 */

export type FireResult =
  | { status: "fired"; sessionUrl: string | null }
  /** `httpStatus` is null when no response came back (no token, timeout, network). */
  | { status: "failed"; httpStatus: number | null; errorType: string };

export interface RoutineFirer {
  fire(triggerId: string, text: string): Promise<FireResult>;
}

export const ROUTINE_FIRE_BASE = "https://api.anthropic.com/v1/claude_code/routines";
/** The endpoint accepts every version from 2023-06-01 on, and behaves the same. */
export const ROUTINE_API_VERSION = "2023-06-01";
export const ROUTINE_API_BETA = "experimental-cc-routine-2026-04-01";
export const FIRE_TIMEOUT_MS = 15_000;

export interface FireRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The request for one fire. `token` null gives a printable copy (routine:fire --dry-run). */
export function fireRequest(triggerId: string, token: string | null, text: string): FireRequest {
  return {
    url: `${ROUTINE_FIRE_BASE}/${encodeURIComponent(triggerId)}/fire`,
    headers: {
      authorization: `Bearer ${token ?? "<ROUTINE_FIRE_TOKENS[" + triggerId + "]>"}`,
      "anthropic-version": ROUTINE_API_VERSION,
      "anthropic-beta": ROUTINE_API_BETA,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

const errorTypeOf = (body: unknown): string | null => {
  const e = (body as { error?: { type?: unknown } } | null)?.error;
  return typeof e?.type === "string" && /^[a-z_]{1,64}$/.test(e.type) ? e.type : null;
};

/** Fires with the owner's per-routine tokens (`{ trigger id: token }`). */
export class AnthropicRoutineFirer implements RoutineFirer {
  constructor(
    private readonly tokens: Readonly<Record<string, string>>,
    private readonly fetchFn: Fetch = fetch as unknown as Fetch,
    private readonly timeoutMs = FIRE_TIMEOUT_MS,
  ) {}

  async fire(triggerId: string, text: string): Promise<FireResult> {
    const token = this.tokens[triggerId];
    if (!token) return { status: "failed", httpStatus: null, errorType: "no_token" };
    const req = fireRequest(triggerId, token, text);
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchFn(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // Only the error's kind: a message could echo the request.
      return { status: "failed", httpStatus: null, errorType: e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network_error" };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) return { status: "failed", httpStatus: res.status, errorType: errorTypeOf(body) ?? `http_${res.status}` };
    const url = (body as { claude_code_session_url?: unknown } | null)?.claude_code_session_url;
    return { status: "fired", sessionUrl: typeof url === "string" && url.startsWith("https://") ? url : null };
  }
}
