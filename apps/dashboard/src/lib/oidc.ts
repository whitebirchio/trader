import type { DashboardConfig } from "./config";
import { OAUTH_TTL_S, randomToken, s256, sign, verify } from "./session";

/**
 * Google sign-in (OpenID Connect, authorization code + PKCE, state, nonce).
 * The ID token comes straight from Google's token endpoint over TLS, with the
 * client secret, so its claims are trusted per OIDC Core 3.1.3.7 step 6 and
 * checked rather than its signature. Only the owner's verified email gets in.
 */

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const callbackUrl = (c: DashboardConfig) => `${c.baseUrl}/auth/callback`;

/** The Google URL to send the browser to, and the signed cookie that remembers state, nonce and verifier. */
export async function startSignIn(c: DashboardConfig, nowS: number): Promise<{ location: string; cookie: string }> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const url = new URL(GOOGLE_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: c.googleClientId,
    redirect_uri: callbackUrl(c),
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { location: url.toString(), cookie: await sign({ t: "oauth", state, nonce, verifier, exp: nowS + OAUTH_TTL_S }, c.sessionKey) };
}

export type SignInResult = { ok: true; email: string } | { ok: false; status: 400 | 403 | 502; reason: string };

const decodeClaims = (idToken: string): Record<string, unknown> | null => {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Validate Google's callback and decide who signed in. `fetchFn` is injectable for tests. */
export async function finishSignIn(
  c: DashboardConfig,
  query: URLSearchParams,
  oauthCookie: string | undefined,
  nowS: number,
  fetchFn: typeof fetch = fetch,
): Promise<SignInResult> {
  const pending = await verify(oauthCookie, c.sessionKey, "oauth", nowS);
  if (!pending) return { ok: false, status: 400, reason: "The sign-in took too long or started elsewhere. Try again." };
  if (query.get("error")) return { ok: false, status: 400, reason: `Google said: ${query.get("error")}` };
  if (query.get("state") !== pending.state) return { ok: false, status: 400, reason: "The sign-in response didn't match this browser. Try again." };
  const code = query.get("code");
  if (!code) return { ok: false, status: 400, reason: "Google returned no code." };

  const res = await fetchFn(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      redirect_uri: callbackUrl(c),
      client_id: c.googleClientId,
      client_secret: c.googleClientSecret,
    }).toString(),
  });
  if (!res.ok) return { ok: false, status: 502, reason: "Google refused the sign-in code." };
  const body = (await res.json()) as { id_token?: string };
  const claims = body.id_token ? decodeClaims(body.id_token) : null;
  if (!claims) return { ok: false, status: 502, reason: "Google returned no identity." };

  if (typeof claims.iss !== "string" || !ISSUERS.includes(claims.iss)) return { ok: false, status: 403, reason: "Unexpected identity issuer." };
  if (claims.aud !== c.googleClientId) return { ok: false, status: 403, reason: "The identity was issued to another app." };
  if (typeof claims.exp !== "number" || claims.exp <= nowS) return { ok: false, status: 403, reason: "The identity has expired." };
  if (claims.nonce !== pending.nonce) return { ok: false, status: 403, reason: "The identity didn't match this sign-in." };
  if (claims.email_verified !== true) return { ok: false, status: 403, reason: "That Google account's email isn't verified." };
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (email !== c.ownerEmail) return { ok: false, status: 403, reason: "This dashboard is private to its owner." };
  return { ok: true, email };
}
