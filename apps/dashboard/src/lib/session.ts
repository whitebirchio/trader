/**
 * Stateless HMAC-signed values for the session and the OAuth round trip, the
 * same scheme as the MCP server's credentials (apps/mcp/src/auth.ts, from
 * Fred): base64url(JSON) "." base64url(HMAC-SHA256). Each payload carries its
 * kind and expiry, so one can never be replayed as the other.
 */

export const SESSION_COOKIE = "__Host-trader_session";
export const OAUTH_COOKIE = "__Host-trader_oauth";
export const SESSION_TTL_S = 30 * 24 * 60 * 60;
export const OAUTH_TTL_S = 10 * 60;
/** A form's anti-forgery token lives this long: long enough to read the confirmation, short enough not to leak usefully. */
export const CSRF_TTL_S = 30 * 60;

export type Signed =
  | { t: "session"; email: string; exp: number }
  | { t: "oauth"; state: string; nonce: string; verifier: string; exp: number }
  /** A write form's anti-forgery token, bound to the signed-in owner (SPEC-capital). */
  | { t: "csrf"; email: string; exp: number };

const enc = new TextEncoder();
export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sign(payload: Signed, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

export async function verify<T extends Signed["t"]>(token: string | undefined, secret: string, kind: T, nowS: number): Promise<Extract<Signed, { t: T }> | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  if (!equal(token.slice(dot + 1), b64url(await hmac(secret, body)))) return null;
  let payload: Signed;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Signed;
  } catch {
    return null;
  }
  if (payload.t !== kind || typeof payload.exp !== "number" || payload.exp <= nowS) return null;
  return payload as Extract<Signed, { t: T }>;
}

export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

/** Cookie attributes: __Host- requires Secure, Path=/ and no Domain. Lax so Google's redirect back carries the OAuth cookie. */
export const cookieOptions = (maxAge: number) => ({ httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge });
