import { describe, expect, it } from "vitest";
import { type NewCommand, csrfToken, handleCommandPost } from "@/lib/commands";
import { type DashboardConfig, parseConfig } from "@/lib/config";
import { sign } from "@/lib/session";

const ENV = {
  TRADING_ENV: "staging",
  DASHBOARD_URL: "https://trader-staging.whitebirch.io",
  OWNER_EMAIL: "owner@example.com",
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
} as unknown as NodeJS.ProcessEnv;
const SECRETS = {
  GOOGLE_CLIENT_SECRET: "GOCSPX-secret-secret-secret",
  DASHBOARD_SESSION_KEY: "k".repeat(48),
  DATABASE_READ_URL: "postgresql://trader_dashboard:pw@ep-x.neon.tech/neondb",
};
const r = parseConfig(ENV, SECRETS);
if (!r.ok) throw new Error(r.problems.join());
const config: DashboardConfig = r.config;
const NOW = 1_800_000_000;
const ORIGIN = "https://trader-staging.whitebirch.io";

const session = (email = "owner@example.com") => sign({ t: "session", email, exp: NOW + 3600 }, config.sessionKey);
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function post(over: { token?: string | null; origin?: string | null; fields?: Record<string, string> } = {}) {
  const inserted: NewCommand[] = [];
  const csrf = await csrfToken(config, "owner@example.com", NOW);
  const result = await handleCommandPost(
    {
      config,
      sessionToken: over.token === null ? undefined : (over.token ?? (await session())),
      origin: over.origin === undefined ? ORIGIN : over.origin,
      form: form(over.fields ?? { kind: "request", amount: "500", confirm: "yes", csrf }),
      nowS: NOW,
    },
    async (c) => {
      inserted.push(c);
      return "cmd-1";
    },
  );
  return { result, inserted, csrf };
}

describe("handleCommandPost (the dashboard's one write)", () => {
  it("queues a confirmed request as the signed-in owner and returns to the Money page", async () => {
    const { result, inserted } = await post();
    expect(result).toEqual({ status: 303, location: `${ORIGIN}/money?sent=request` });
    expect(inserted).toEqual([{ kind: "request", amount: "500", requestedBy: "dashboard:owner@example.com" }]);
  });

  it("queues cancel and fund_now without an amount, and all as all", async () => {
    const csrf = await csrfToken(config, "owner@example.com", NOW);
    for (const [kind, amount, expected] of [["cancel", "999", null], ["fund_now", "", null], ["request", "ALL", "all"]] as const) {
      const { inserted } = await post({ fields: { kind, amount, confirm: "yes", csrf } });
      expect(inserted).toEqual([{ kind, amount: expected, requestedBy: "dashboard:owner@example.com" }]);
    }
  });

  it("refuses without a valid owner session (401)", async () => {
    expect((await post({ token: null })).result).toMatchObject({ status: 401 });
    expect((await post({ token: await session("someone@else.com") })).result).toMatchObject({ status: 401 });
    expect((await post({ token: "forged.token" })).result).toMatchObject({ status: 401 });
  });

  it("refuses a request from anywhere but the dashboard's own origin, or with none (403)", async () => {
    for (const origin of ["https://evil.example", "https://trader.whitebirch.io", "null", null]) {
      const { result, inserted } = await post({ origin });
      expect(result).toMatchObject({ status: 403 });
      expect(inserted).toEqual([]);
    }
  });

  it("refuses a missing, forged, expired or someone else's form token (403)", async () => {
    const expired = await csrfToken(config, "owner@example.com", NOW - 31 * 60);
    const otherOwner = await sign({ t: "csrf", email: "someone@else.com", exp: NOW + 600 }, config.sessionKey);
    const sessionAsCsrf = await session(); // a session token is the wrong kind
    for (const csrf of [undefined, "x.y", expired, otherOwner, sessionAsCsrf]) {
      const fields: Record<string, string> = { kind: "request", amount: "500", confirm: "yes" };
      if (csrf) fields.csrf = csrf;
      const { result, inserted } = await post({ fields });
      expect(result).toMatchObject({ status: 403 });
      expect(inserted).toEqual([]);
    }
  });

  it("refuses an unconfirmed, unknown or badly amounted command (400), inserting nothing", async () => {
    const csrf = await csrfToken(config, "owner@example.com", NOW);
    const cases: Record<string, string>[] = [
      { kind: "request", amount: "500", csrf },
      { kind: "withdraw_to_my_account", amount: "500", confirm: "yes", csrf },
      { kind: "request", amount: "-5", confirm: "yes", csrf },
      { kind: "request", amount: "$500", confirm: "yes", csrf },
      { kind: "request", confirm: "yes", csrf },
    ];
    for (const fields of cases) {
      const { result, inserted } = await post({ fields });
      expect(result).toMatchObject({ status: 400 });
      expect(inserted).toEqual([]);
    }
  });
});
