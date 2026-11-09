import { type NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { SESSION_COOKIE, verify } from "@/lib/session";

/**
 * Runs before every route except static assets: fail closed on bad config,
 * send anyone without a valid owner session to /login, and set a per-request
 * CSP nonce (Next applies it to its own scripts).
 */
const PUBLIC = new Set(["/login", "/auth/start", "/auth/callback", "/auth/logout"]);

function csp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const loaded = await loadConfig();
  if (!loaded.ok) {
    return new NextResponse(`Trader dashboard is misconfigured: ${loaded.problems.join(", ")}`, { status: 503, headers: { "content-type": "text/plain" } });
  }
  const { config } = loaded;
  const path = request.nextUrl.pathname;

  if (!PUBLIC.has(path)) {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const session = config.devEmail ? { email: config.devEmail } : await verify(token, config.sessionKey, "session", Math.floor(Date.now() / 1000));
    if (!session || session.email !== config.ownerEmail) return NextResponse.redirect(`${config.baseUrl}/login`, 302);
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const policy = csp(nonce, process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "same-origin");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return response;
}

// Image optimization (/_next/image) is off (next.config.ts), and it isn't
// exempt here either, so it would need a session even if it came back.
export const config = {
  matcher: ["/((?!_next/static|favicon.ico|manifest.webmanifest|icons/).*)"],
};
