import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/** POST only, so a link or image elsewhere can't sign you out. */
export async function POST() {
  const loaded = await loadConfig();
  if (!loaded.ok) return new NextResponse("misconfigured", { status: 503 });
  const res = NextResponse.redirect(`${loaded.config.baseUrl}/login`, 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
