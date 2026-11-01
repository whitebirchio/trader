import { type NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { finishSignIn } from "@/lib/oidc";
import { OAUTH_COOKIE, SESSION_COOKIE, SESSION_TTL_S, cookieOptions, sign } from "@/lib/session";

export const dynamic = "force-dynamic";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function GET(request: NextRequest) {
  const loaded = await loadConfig();
  if (!loaded.ok) return new NextResponse("misconfigured", { status: 503 });
  const { config } = loaded;
  const nowS = Math.floor(Date.now() / 1000);
  const result = await finishSignIn(config, request.nextUrl.searchParams, request.cookies.get(OAUTH_COOKIE)?.value, nowS);

  if (!result.ok) {
    console.log(JSON.stringify({ level: "info", message: "sign-in refused", status: result.status, reason: result.reason }));
    const res = new NextResponse(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trader</title><body style="font:16px system-ui;padding:2rem;max-width:30rem;margin:auto"><h1 style="font-size:1.2rem">Can't sign in</h1><p>${escape(result.reason)}</p><p><a href="/login">Back</a></p>`,
      { status: result.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
    res.cookies.delete(OAUTH_COOKIE);
    return res;
  }

  console.log(JSON.stringify({ level: "info", message: "signed in" }));
  const res = NextResponse.redirect(`${config.baseUrl}/`, 302);
  res.cookies.set(SESSION_COOKIE, await sign({ t: "session", email: result.email, exp: nowS + SESSION_TTL_S }, config.sessionKey), cookieOptions(SESSION_TTL_S));
  res.cookies.delete(OAUTH_COOKIE);
  return res;
}
