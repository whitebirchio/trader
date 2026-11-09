// ---------------------------------------------------------------------------
// Auth for Trader's MCP server (SPEC-agent).
//
// Ported from Fred (~/fred/src/mcp/auth.ts, Scott's own code). The logic is
// unchanged; names, scope and the consent copy are Trader's. This module is
// the only gate between the open internet and a server that can change what a
// real-money account trades, so it fails closed throughout.
//
// Two ways in, both ending at the same `Authorization: Bearer` check:
//
//   1. OAuth 2.1 (MCP authorization spec): what claude.ai connectors and
//      routines use. Discovery -> dynamic client registration -> passphrase ->
//      PKCE code exchange.
//   2. A static token in MCP_TOKEN: Claude Code, curl, debugging.
//
// Everything is stateless. Client ids, authorization codes, access tokens and
// refresh tokens are all HMAC-signed blobs that carry their own expiry and
// audience, so there are no tables and nothing to clean up. Rotating
// MCP_SIGNING_KEY revokes every credential at once.
// ---------------------------------------------------------------------------

export type AuthEnv = {
  MCP_TOKEN?: string;
  MCP_PASSPHRASE?: string;
  MCP_SIGNING_KEY?: string;
};

/** Shorter secrets are treated as unset, so a placeholder can never open the door. */
export const MIN_SECRET_LENGTH = 32;
export const MIN_PASSPHRASE_LENGTH = 16;

const usable = (value: string | undefined, min: number) => {
  const v = value?.trim();
  return v && v.length >= min ? v : undefined;
};

/** The configured secrets that are long enough to trust; the rest read as unset. */
export function authSecrets(env: AuthEnv) {
  return {
    token: usable(env.MCP_TOKEN, MIN_SECRET_LENGTH),
    signingKey: usable(env.MCP_SIGNING_KEY, MIN_SECRET_LENGTH),
    passphrase: usable(env.MCP_PASSPHRASE, MIN_PASSPHRASE_LENGTH),
  };
}

/** Hosts a redirect may point at, independent of what was registered. The
 *  authorize endpoint is publicly reachable, so without this an attacker could
 *  register a client pointing anywhere and use Trader as an open redirect — the
 *  case the MCP spec calls out under "Open Redirection". */
const REDIRECT_HOST_ALLOWLIST = [
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "www.claude.com",
  "localhost",
  "127.0.0.1",
];

/** One scope: read the portfolio and submit strategies. There is no order scope (ADR-011). */
const SCOPE = "trader";

const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const AUTH_CODE_TTL = 5 * 60; // 5 minutes

// Signing --------------------------------------------------------------------

const enc = new TextEncoder();

const b64urlEncode = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Length-independent equality. Bails early only on length, which is not secret
 *  (tokens here are fixed-shape), never on content. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let keyCache: { secret: string; key: CryptoKey } | null = null;

async function signingKey(secret: string): Promise<CryptoKey> {
  if (keyCache && keyCache.secret === secret) return keyCache.key;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  keyCache = { secret, key };
  return key;
}

/** What every credential this module issues carries. */
export type TokenPayload = {
  /** Credential kind, so an authorization code can never be replayed as an
   *  access token (or vice versa) even though both are signed with one key. */
  t: "client" | "code" | "access" | "refresh";
  /** Expiry, epoch seconds. */
  exp: number;
  /** Audience: the canonical MCP endpoint URL this credential is good for. The
   *  spec requires the server to reject tokens minted for anything else. */
  aud: string;
  /** Registered redirect URIs (client ids only) — this is what lets /authorize
   *  validate a redirect without a database. */
  ru?: string[];
  /** PKCE challenge (authorization codes only). */
  cc?: string;
  /** The redirect_uri the code was issued against, re-checked at /token. */
  rd?: string;
  /** Issuing client id, so a code cannot be redeemed by a different client. */
  cid?: string;
  /** Random per-issuance nonce. Signing is deterministic, so without this two
   *  tokens minted in the same second would be byte-identical. */
  n?: string;
};

const nonce = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));

export async function sign(
  payload: TokenPayload,
  secret: string,
): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await signingKey(secret);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(body) as unknown as BufferSource,
  );
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

export async function verify(
  token: string,
  secret: string,
  expect: TokenPayload["t"],
  audience: string,
  now: number = Date.now(),
): Promise<TokenPayload | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const key = await signingKey(secret);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(mac) as unknown as BufferSource,
      enc.encode(body) as unknown as BufferSource,
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }

  if (payload.t !== expect) return null;
  if (payload.aud !== audience) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return payload;
}

// PKCE -----------------------------------------------------------------------

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(verifier) as unknown as BufferSource,
  );
  return b64urlEncode(new Uint8Array(digest));
}

// Server identity ------------------------------------------------------------

/** This server's own URLs, derived from the request so the same code works on
 *  the Function URL, a custom domain, and tests. */
export type ServerUrls = { issuer: string; resource: string };

export function serverUrls(request: Request): ServerUrls {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  return { issuer, resource: `${issuer}/mcp` };
}

// Discovery documents --------------------------------------------------------

export function protectedResourceMetadata(urls: ServerUrls) {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "Trader",
    resource_documentation: `${urls.issuer}/`,
  };
}

export function authorizationServerMetadata(urls: ServerUrls) {
  return {
    issuer: urls.issuer,
    authorization_endpoint: `${urls.issuer}/authorize`,
    token_endpoint: `${urls.issuer}/token`,
    registration_endpoint: `${urls.issuer}/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Public clients only: PKCE is the proof, there is no client secret to keep.
    token_endpoint_auth_methods_supported: ["none"],
  };
}

// Redirect validation --------------------------------------------------------

export function redirectAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // The OAuth spec permits only https, or localhost over http.
  const isLocal =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    return false;
  }
  if (url.hash) return false;
  return REDIRECT_HOST_ALLOWLIST.includes(url.hostname);
}

// Dynamic client registration -------------------------------------------------

export type RegistrationResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * RFC 7591. Claude registers itself here, which is what removes every manual
 * configuration step for the user. The issued `client_id` is a signed blob
 * carrying the redirect URIs, so /authorize can validate a redirect later with
 * nothing stored in between.
 */
export async function registerClient(
  body: unknown,
  urls: ServerUrls,
  secret: string,
  now: number = Date.now(),
): Promise<RegistrationResult> {
  const req = (body ?? {}) as Record<string, unknown>;
  const uris = Array.isArray(req.redirect_uris)
    ? req.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];

  if (uris.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required",
      },
    };
  }
  const rejected = uris.filter((u) => !redirectAllowed(u));
  if (rejected.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_redirect_uri",
        error_description: `redirect_uri host is not allowed: ${rejected.join(", ")}`,
      },
    };
  }

  const clientId = await sign(
    {
      t: "client",
      // A client registration outlives its refresh tokens, or re-auth would
      // fail with an unknown client after a month of use.
      exp: Math.floor(now / 1000) + 365 * 24 * 60 * 60,
      aud: urls.resource,
      ru: uris,
    },
    secret,
  );

  return {
    ok: true,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name:
        typeof req.client_name === "string" ? req.client_name : "MCP client",
    },
  };
}

// Authorization ---------------------------------------------------------------

export type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
};

export type AuthorizeCheck =
  | { ok: true; params: AuthorizeParams }
  /** Something is wrong with the request itself. The spec forbids redirecting
   *  to an unvalidated URI, so these are rendered as a page, never bounced. */
  | { ok: false; render: string; status: number }
  /** The request is well-formed but the grant fails; safe to redirect back. */
  | { ok: false; redirect: string };

/**
 * Validate an /authorize request without granting anything. Splitting this from
 * the passphrase check means the GET (show the form) and the POST (submit it)
 * apply exactly the same rules.
 */
export async function checkAuthorize(
  query: URLSearchParams,
  urls: ServerUrls,
  secret: string,
  now: number = Date.now(),
): Promise<AuthorizeCheck> {
  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  const state = query.get("state");
  const codeChallenge = query.get("code_challenge") ?? "";
  const method = query.get("code_challenge_method") ?? "";
  const responseType = query.get("response_type") ?? "";
  const resource = query.get("resource");

  const client = clientId
    ? await verify(clientId, secret, "client", urls.resource, now)
    : null;
  if (!client) {
    return {
      ok: false,
      status: 400,
      render: "Unknown or expired client registration. Remove the connector in Claude and add it again.",
    };
  }

  // Redirect must be one this client registered *and* on the host allowlist.
  if (!redirectUri || !client.ru?.includes(redirectUri) || !redirectAllowed(redirectUri)) {
    return {
      ok: false,
      status: 400,
      render: "The redirect address on this request is not one this client registered.",
    };
  }

  // From here the redirect is trusted, so errors go back to the client.
  const bounce = (error: string, description: string) => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    return { ok: false as const, redirect: target.toString() };
  };

  if (responseType !== "code") {
    return bounce("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!codeChallenge || method !== "S256") {
    return bounce("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  // RFC 8707: the token must be bound to this specific MCP server. Clients MUST
  // send it; accept its absence for robustness but never accept a mismatch.
  if (resource && normalizeResource(resource) !== urls.resource) {
    return bounce("invalid_target", "resource does not match this server");
  }

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      resource,
      scope: query.get("scope"),
    },
  };
}

const normalizeResource = (raw: string) => raw.replace(/\/$/, "");

/** Mint the authorization code and build the redirect back to the client. */
export async function grantCode(
  params: AuthorizeParams,
  urls: ServerUrls,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const code = await sign(
    {
      t: "code",
      exp: Math.floor(now / 1000) + AUTH_CODE_TTL,
      aud: urls.resource,
      cc: params.codeChallenge,
      rd: params.redirectUri,
      cid: params.clientId,
    },
    secret,
  );
  const target = new URL(params.redirectUri);
  target.searchParams.set("code", code);
  if (params.state) target.searchParams.set("state", params.state);
  return target.toString();
}

// Token endpoint ---------------------------------------------------------------

export type TokenResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

const oauthError = (
  error: string,
  description: string,
  status = 400,
): TokenResult => ({
  ok: false,
  status,
  body: { error, error_description: description },
});

async function issueTokens(
  clientId: string,
  urls: ServerUrls,
  secret: string,
  now: number,
): Promise<Record<string, unknown>> {
  const seconds = Math.floor(now / 1000);
  const [accessToken, refreshToken] = await Promise.all([
    sign(
      {
        t: "access",
        exp: seconds + ACCESS_TOKEN_TTL,
        aud: urls.resource,
        cid: clientId,
        n: nonce(),
      },
      secret,
    ),
    sign(
      {
        t: "refresh",
        exp: seconds + REFRESH_TOKEN_TTL,
        aud: urls.resource,
        cid: clientId,
        n: nonce(),
      },
      secret,
    ),
  ]);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    // A fresh refresh token is issued on every exchange, but be clear about
    // what that does and does not buy: with no server-side state there is no
    // way to invalidate the *previous* one, so this is not the replay
    // detection OAuth 2.1 describes for public clients. A leaked refresh token
    // stays usable until it expires or MCP_SIGNING_KEY is rotated, which is
    // the documented trade-off for a stateless single-user server
    // (SPEC-agent). Access tokens are short-lived to keep that window small.
    refresh_token: refreshToken,
    scope: SCOPE,
  };
}

export async function exchangeToken(
  form: URLSearchParams,
  urls: ServerUrls,
  secret: string,
  now: number = Date.now(),
): Promise<TokenResult> {
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const clientId = form.get("client_id") ?? "";

    const payload = await verify(code, secret, "code", urls.resource, now);
    if (!payload) return oauthError("invalid_grant", "Authorization code is invalid or expired");
    if (!verifier) return oauthError("invalid_request", "code_verifier is required");
    if (payload.rd !== redirectUri) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (clientId && payload.cid !== clientId) {
      return oauthError("invalid_grant", "Authorization code was issued to a different client");
    }
    if (!timingSafeEqual(await s256(verifier), payload.cc ?? "")) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    return { ok: true, body: await issueTokens(payload.cid ?? "", urls, secret, now) };
  }

  if (grantType === "refresh_token") {
    const token = form.get("refresh_token") ?? "";
    const payload = await verify(token, secret, "refresh", urls.resource, now);
    if (!payload) return oauthError("invalid_grant", "Refresh token is invalid or expired");
    return { ok: true, body: await issueTokens(payload.cid ?? "", urls, secret, now) };
  }

  return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType ?? "(none)"}`);
}

// Bearer check on the MCP endpoint ----------------------------------------------

export type AuthOutcome =
  | { ok: true; via: "static" | "oauth" }
  | { ok: false; reason: string };

/**
 * The single gate on /mcp. A static token wins outright; otherwise the value is
 * verified as an OAuth access token minted by this server for this server.
 */
export async function authenticate(
  request: Request,
  env: AuthEnv,
  urls: ServerUrls,
  now: number = Date.now(),
): Promise<AuthOutcome> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return { ok: false, reason: "no bearer token" };
  const presented = (match[1] ?? "").trim();

  const { token: staticToken, signingKey: secret } = authSecrets(env);
  if (staticToken && timingSafeEqual(presented, staticToken)) {
    return { ok: true, via: "static" };
  }

  if (secret) {
    const payload = await verify(presented, secret, "access", urls.resource, now);
    if (payload) return { ok: true, via: "oauth" };
  }

  return { ok: false, reason: "token is not valid for this server" };
}

/** 401 carrying the pointer to resource metadata that starts the OAuth dance
 *  (RFC 9728 §5.1) — this response is what makes "Connect" work in Claude. */
export function unauthorized(urls: ServerUrls, description: string): Response {
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: description }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="Trader", resource_metadata="${urls.issuer}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

// The passphrase page -------------------------------------------------------------

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const page = (title: string, inner: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Trader</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
         background:#fafaf9; color:#1c1917; padding:24px; }
  main { width:100%; max-width:22rem; }
  h1 { font-size:1.25rem; margin:0 0 .25rem; }
  p { color:#57534e; margin:0 0 1.25rem; font-size:.9rem; }
  label { display:block; font-size:.8rem; font-weight:600; margin-bottom:.35rem; }
  input { width:100%; box-sizing:border-box; padding:.6rem .7rem; font-size:1rem;
          border:1px solid #d6d3d1; border-radius:.5rem; background:#fff; color:inherit; }
  button { width:100%; margin-top:.9rem; padding:.6rem; font-size:1rem; font-weight:600;
           border:0; border-radius:.5rem; background:#1c1917; color:#fafaf9; cursor:pointer; }
  .err { color:#b91c1c; font-size:.85rem; margin:.6rem 0 0; }
  @media (prefers-color-scheme: dark) {
    body { background:#0c0a09; color:#fafaf9; }
    p { color:#a8a29e; }
    input { background:#1c1917; border-color:#44403c; }
    button { background:#fafaf9; color:#0c0a09; }
  }
</style></head><body><main>${inner}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The one page a person sees: inline styles and a same-origin form, nothing else, and never framed.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    },
  );

export const errorPage = (message: string, status = 400) =>
  page(
    "Cannot continue",
    `<h1>Cannot continue</h1><p>${escapeHtml(message)}</p>`,
    status,
  );

/** The one screen a human ever sees from this server. */
export function passphrasePage(
  query: URLSearchParams,
  error?: string,
): Response {
  // Carry the whole authorize request through the form so the POST re-validates
  // against exactly the same parameters the GET did.
  const hidden = [...query.entries()]
    .filter(([k]) => k !== "passphrase")
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join("");

  return page(
    "Connect Trader",
    `<h1>Connect Trader</h1>
     <p>Claude is asking to read your Trader portfolio and submit strategies for it to trade. Enter the Trader connector passphrase to allow it.</p>
     <form method="post" action="/authorize">
       ${hidden}
       <label for="passphrase">Passphrase</label>
       <input id="passphrase" name="passphrase" type="password" autocomplete="current-password"
              autofocus required>
       ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
       <button type="submit">Allow</button>
     </form>`,
    error ? 401 : 200,
  );
}
