import type { Db } from "@trader/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type DashboardConfig, loadConfig } from "./config";
import { dbFor } from "./db";
import { SESSION_COOKIE, verify } from "./session";

/** Who is signed in, or null. The proxy checks this first; pages check it again before reading data. */
export async function sessionEmail(config: DashboardConfig, token: string | undefined, nowS: number): Promise<string | null> {
  if (config.devEmail) return config.devEmail === config.ownerEmail ? config.devEmail : null;
  const session = await verify(token, config.sessionKey, "session", nowS);
  return session && session.email === config.ownerEmail ? session.email : null;
}

/** For every signed-in page: the config and a read-only database, or a redirect to sign in. */
export async function signedIn(): Promise<{ config: DashboardConfig; db: Db; email: string }> {
  const loaded = await loadConfig();
  if (!loaded.ok) throw new Error(`dashboard misconfigured: ${loaded.problems.join(", ")}`);
  const email = await sessionEmail(loaded.config, (await cookies()).get(SESSION_COOKIE)?.value, Math.floor(Date.now() / 1000));
  if (!email) redirect("/login");
  return { config: loaded.config, db: dbFor(loaded.config.databaseReadUrl), email };
}
