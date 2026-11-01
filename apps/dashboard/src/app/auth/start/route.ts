import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { startSignIn } from "@/lib/oidc";
import { OAUTH_COOKIE, OAUTH_TTL_S, cookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const loaded = await loadConfig();
  if (!loaded.ok) return new NextResponse("misconfigured", { status: 503 });
  const { location, cookie } = await startSignIn(loaded.config, Math.floor(Date.now() / 1000));
  const res = NextResponse.redirect(location, 302);
  res.cookies.set(OAUTH_COOKIE, cookie, cookieOptions(OAUTH_TTL_S));
  return res;
}
