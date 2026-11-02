import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { handleCommandPost } from "@/lib/commands";
import { loadConfig } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/session";
import { insertCommand } from "@/lib/write";

export const dynamic = "force-dynamic";

/** POST /money/command: the confirmation page's form. Every check is in handleCommandPost. */
export async function POST(request: Request) {
  const loaded = await loadConfig();
  if (!loaded.ok) return new NextResponse("misconfigured", { status: 503 });
  const { config } = loaded;
  const result = await handleCommandPost(
    {
      config,
      sessionToken: (await cookies()).get(SESSION_COOKIE)?.value,
      origin: (await headers()).get("origin"),
      form: await request.formData(),
      nowS: Math.floor(Date.now() / 1000),
    },
    (command) => insertCommand(config.databaseReadUrl, command),
  );
  if (result.status === 303) return NextResponse.redirect(result.location, 303);
  return new NextResponse(result.message, { status: result.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
