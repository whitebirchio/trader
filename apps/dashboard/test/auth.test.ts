import { describe, expect, it } from "vitest";
import { type DashboardConfig, parseConfig } from "@/lib/config";
import { finishSignIn, startSignIn } from "@/lib/oidc";
import { s256, sign, verify } from "@/lib/session";

const ENV = {
  TRADING_ENV: "staging",
  DASHBOARD_URL: "https://trader-staging.whitebirch.io",
  OWNER_EMAIL: "Owner@Example.com",
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
} as unknown as NodeJS.ProcessEnv;
const SECRETS = {
  GOOGLE_CLIENT_SECRET: "GOCSPX-secret-secret-secret",
  DASHBOARD_SESSION_KEY: "k".repeat(48),
  DATABASE_READ_URL: "postgresql://trader_dashboard:pw@ep-x.neon.tech/neondb",
};
const config = (): DashboardConfig => {
  const r = parseConfig(ENV, SECRETS);
  if (!r.ok) throw new Error(r.problems.join());
  return r.config;
};
const NOW = 1_800_000_000;

describe("config", () => {
  it("parses, lower-casing the owner email", () => {
    expect(config()).toMatchObject({ env: "staging", ownerEmail: "owner@example.com", devEmail: null });
  });

  it("fails closed, naming only what's wrong", () => {
    const r = parseConfig({ ...ENV, DASHBOARD_URL: "http://evil.example" }, { ...SECRETS, DASHBOARD_SESSION_KEY: "short", DATABASE_READ_URL: "postgresql://trader_app:pw@h/db" });
    expect(r).toEqual({ ok: false, problems: ["DASHBOARD_URL", "DASHBOARD_SESSION_KEY", "DATABASE_READ_URL"] });
  });

  it("allows the dev bypass only in development", () => {
    expect(parseConfig({ ...ENV, NODE_ENV: "production", DASHBOARD_DEV_EMAIL: "owner@example.com" }, SECRETS)).toMatchObject({ config: { devEmail: null } });
    expect(parseConfig({ ...ENV, NODE_ENV: "development", DASHBOARD_DEV_EMAIL: "owner@example.com" }, SECRETS)).toMatchObject({ config: { devEmail: "owner@example.com" } });
  });
});

describe("signed values", () => {
  it("round-trip; reject tampering, the wrong kind, expiry and the wrong key", async () => {
    const key = "k".repeat(48);
    const token = await sign({ t: "session", email: "owner@example.com", exp: NOW + 60 }, key);
    expect(await verify(token, key, "session", NOW)).toMatchObject({ email: "owner@example.com" });
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ t: "session", email: "evil@example.com", exp: NOW + 60 })).toString("base64url");
    expect(await verify(`${forged}.${mac}`, key, "session", NOW)).toBeNull();
    expect(await verify(`${body}.x${mac!.slice(1)}`, key, "session", NOW)).toBeNull();
    expect(await verify(token, key, "oauth", NOW)).toBeNull();
    expect(await verify(token, key, "session", NOW + 61)).toBeNull();
    expect(await verify(token, "j".repeat(48), "session", NOW)).toBeNull();
    expect(await verify(undefined, key, "session", NOW)).toBeNull();
  });
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

async function begin() {
  const c = config();
  const { location, cookie } = await startSignIn(c, NOW);
  const url = new URL(location);
  return { c, cookie, url, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
}

function google(claims: Record<string, unknown>, seen: { body?: URLSearchParams } = {}) {
  return (async (_url: string, init: RequestInit) => {
    seen.body = new URLSearchParams(String(init.body));
    return new Response(JSON.stringify({ id_token: idToken(claims) }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Google sign-in", () => {
  it("starts with PKCE, state and nonce, redirecting back to the configured origin", async () => {
    const { url } = await begin();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "123-abc.apps.googleusercontent.com",
      redirect_uri: "https://trader-staging.whitebirch.io/auth/callback",
      response_type: "code",
      scope: "openid email",
      code_challenge_method: "S256",
    });
  });

  it("lets the owner in, sending the PKCE verifier and client secret to Google", async () => {
    const { c, cookie, state, nonce, url } = await begin();
    const seen: { body?: URLSearchParams } = {};
    const ok = { iss: "https://accounts.google.com", aud: c.googleClientId, exp: NOW + 300, nonce, email: "OWNER@example.com", email_verified: true };
    const r = await finishSignIn(c, new URLSearchParams({ state, code: "c0de" }), cookie, NOW, google(ok, seen));
    expect(r).toEqual({ ok: true, email: "owner@example.com" });
    expect(await s256(seen.body!.get("code_verifier")!)).toBe(url.searchParams.get("code_challenge"));
    expect(seen.body!.get("client_secret")).toBe(SECRETS.GOOGLE_CLIENT_SECRET);
  });

  it("refuses everyone and everything else", async () => {
    const { c, cookie, state, nonce } = await begin();
    const ok = { iss: "https://accounts.google.com", aud: c.googleClientId, exp: NOW + 300, nonce, email: "owner@example.com", email_verified: true };
    const q = new URLSearchParams({ state, code: "c0de" });
    const cases: [string, Record<string, unknown>, number][] = [
      ["another account", { ...ok, email: "someone@example.com" }, 403],
      ["unverified email", { ...ok, email_verified: false }, 403],
      ["wrong audience", { ...ok, aud: "other.apps.googleusercontent.com" }, 403],
      ["wrong issuer", { ...ok, iss: "https://evil.example" }, 403],
      ["expired token", { ...ok, exp: NOW - 1 }, 403],
      ["wrong nonce", { ...ok, nonce: "replayed" }, 403],
    ];
    for (const [, claims, status] of cases) {
      expect(await finishSignIn(c, q, cookie, NOW, google(claims))).toMatchObject({ ok: false, status });
    }
    expect(await finishSignIn(c, new URLSearchParams({ state: "other", code: "c" }), cookie, NOW, google(ok))).toMatchObject({ ok: false, status: 400 });
    expect(await finishSignIn(c, q, undefined, NOW, google(ok))).toMatchObject({ ok: false, status: 400 });
    expect(await finishSignIn(c, q, cookie, NOW + 601, google(ok))).toMatchObject({ ok: false, status: 400 }); // the round trip expired
    const refused = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    expect(await finishSignIn(c, q, cookie, NOW, refused)).toMatchObject({ ok: false, status: 502 });
  });
});
