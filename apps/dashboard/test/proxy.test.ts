import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { SESSION_COOKIE, sign } from "@/lib/session";

const KEY = "k".repeat(48);

beforeEach(() => {
  Object.assign(process.env, {
    TRADING_ENV: "staging",
    DASHBOARD_URL: "https://trader-staging.whitebirch.io",
    OWNER_EMAIL: "owner@example.com",
    GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "GOCSPX-secret-secret-secret",
    DASHBOARD_SESSION_KEY: KEY,
    DATABASE_READ_URL: "postgresql://trader_dashboard:pw@ep-x.neon.tech/neondb",
  });
  delete process.env.SECRETS_PATH;
  delete process.env.DASHBOARD_DEV_EMAIL;
});

const req = (path: string, cookie?: string) =>
  new NextRequest(`https://8f6j.lambda-web.us-east-1.on.aws${path}`, { headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {} });

describe("proxy", () => {
  it("sends anyone without a session to /login on the public origin, not the Web Function's", async () => {
    const res = await proxy(req("/holdings"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://trader-staging.whitebirch.io/login");
  });

  it("lets the owner through with a nonce CSP and no caching", async () => {
    const token = await sign({ t: "session", email: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 60 }, KEY);
    const res = await proxy(req("/", token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'; .*frame-ancestors 'none'/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a session for anyone but the owner, and an expired one", async () => {
    const other = await sign({ t: "session", email: "someone@example.com", exp: Math.floor(Date.now() / 1000) + 60 }, KEY);
    const old = await sign({ t: "session", email: "owner@example.com", exp: Math.floor(Date.now() / 1000) - 1 }, KEY);
    expect((await proxy(req("/", other))).status).toBe(302);
    expect((await proxy(req("/", old))).status).toBe(302);
  });

  it("leaves the sign-in routes open", async () => {
    for (const p of ["/login", "/auth/start", "/auth/callback"]) expect((await proxy(req(p))).status).toBe(200);
  });

  it("fails closed when misconfigured, naming the variables", async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const res = await proxy(req("/login"));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("GOOGLE_CLIENT_SECRET");
  });
});
