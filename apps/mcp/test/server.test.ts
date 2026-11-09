import { beforeEach, describe, expect, it } from "vitest";
import { type Db, syncBroker } from "@trader/core";
import { FakeBroker } from "../../../packages/core/test/broker/fake-broker.js";
import { createTestDb } from "../../../packages/core/test/helpers.js";
import { sign } from "../src/auth.js";
import { createServer, type ServerDeps } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

const BASE = "https://abc123.lambda-url.us-east-1.on.aws";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const SECRETS = {
  MCP_SIGNING_KEY: "k".repeat(48),
  MCP_PASSPHRASE: "correct horse battery staple",
  MCP_TOKEN: "t".repeat(40),
};
const CONFIG = {
  TRADING_ENV: "staging",
  DATABASE_URL: "postgresql://trader_app:x@ep-test-pooler.us-east-1.aws.neon.tech/neondb",
  ALPACA_KEY_ID: "PKTESTKEY0000000000000000A",
  ALPACA_SECRET_KEY: "secret0000000000000000000000000000000000000",
};

let db: Db;
let env: Record<string, unknown>;
let now: Date;
let opened: number;
let closed: number;
let logs: { level: string; message: string; detail?: Record<string, unknown> }[];
let broker: FakeBroker;

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  now = new Date("2026-11-02T15:35:00Z");
  broker.now = now;
  await syncBroker(db, broker, "staging", now);
  env = { ...CONFIG, ...SECRETS };
  opened = 0;
  closed = 0;
  logs = [];
});

const deps = (): ServerDeps => ({
  loadEnv: async () => env,
  openDb: async () => {
    opened++;
    return { db, close: async () => void closed++ };
  },
  makeBroker: () => broker,
  now: () => now,
  log: (level, message, detail) => logs.push({ level, message, detail }),
});

const call = (path: string, init: RequestInit = {}) => createServer(deps())(new Request(`${BASE}${path}`, init));

const rpc = (body: unknown, token = SECRETS.MCP_TOKEN, headers: Record<string, string> = {}) =>
  call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const tool = async (name: string, args?: unknown) => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { code: number; message: string } };
};

const b64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");
const s256 = async (verifier: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

/** Register, consent with the passphrase, and exchange the code: what claude.ai does. */
async function connect(verifier = "v".repeat(50)) {
  const reg = await call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const query = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    state: "xyz",
    resource: RESOURCE,
  });
  return { client_id, query, verifier };
}

async function consent(query: URLSearchParams, passphrase = SECRETS.MCP_PASSPHRASE) {
  const form = new URLSearchParams(query);
  form.set("passphrase", passphrase);
  return call("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
}

async function exchange(form: Record<string, string>) {
  const res = await call("/token", { method: "POST", body: new URLSearchParams(form).toString() });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

describe("fails closed", () => {
  it("serves nothing without a usable signing key or token", async () => {
    env = { ...CONFIG };
    expect((await call("/.well-known/oauth-authorization-server")).status).toBe(503);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(503);
  });

  it("treats short secrets as unset, so a placeholder can't open the door", async () => {
    env = { ...CONFIG, MCP_TOKEN: "changeme", MCP_SIGNING_KEY: "short" };
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "changeme")).status).toBe(503);
  });

  it("won't grant access without a passphrase", async () => {
    env = { ...CONFIG, MCP_SIGNING_KEY: SECRETS.MCP_SIGNING_KEY, MCP_PASSPHRASE: "short" };
    const { query } = await connect();
    expect((await call(`/authorize?${query}`)).status).toBe(503);
  });

  it("reports bad config by name after auth, and runs no tools", async () => {
    env = { ...SECRETS, TRADING_ENV: "staging" };
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "misconfigured", missing: ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY", "DATABASE_URL"], invalid: [] });
    expect(opened).toBe(0);
  });
});

describe("OAuth", () => {
  it("publishes discovery documents for this server", async () => {
    const pr = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(pr).toMatchObject({ resource: RESOURCE, authorization_servers: [BASE], resource_name: "Trader", scopes_supported: ["trader"] });
    const as = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: BASE, token_endpoint: `${BASE}/token`, code_challenge_methods_supported: ["S256"] });
  });

  it("register → passphrase → PKCE exchange → a token that works on /mcp", async () => {
    const { client_id, query, verifier } = await connect();

    const page = await call(`/authorize?${query}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect Trader");
    // Never framed (clickjacking), never cached, and nothing loads but its own inline styles.
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cache-control")).toBe("no-store");

    const wrong = await consent(query, "not the passphrase at all");
    expect(wrong.status).toBe(401);

    const granted = await consent(query);
    expect(granted.status).toBe(302);
    const location = new URL(granted.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("xyz");

    const tokens = await exchange({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, redirect_uri: REDIRECT, client_id });
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "trader" });

    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tokens.body.access_token);
    expect(res.status).toBe(200);

    // The refresh token mints a new access token, and is never one itself.
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tokens.body.refresh_token)).status).toBe(401);
    const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: tokens.body.refresh_token! });
    expect(refreshed.status).toBe(200);
  });

  it("rejects a wrong PKCE verifier, and redirects off the allowlist", async () => {
    const { client_id, query } = await connect();
    const code = new URL((await consent(query)).headers.get("location")!).searchParams.get("code")!;
    const bad = await exchange({ grant_type: "authorization_code", code, code_verifier: "w".repeat(50), redirect_uri: REDIRECT, client_id });
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const reg = await call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
    expect(reg.status).toBe(400);
  });

  it("rejects expired and wrong-audience tokens with a pointer to discovery", async () => {
    const { client_id, query, verifier } = await connect();
    const code = new URL((await consent(query)).headers.get("location")!).searchParams.get("code")!;
    const { body } = await exchange({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id });

    now = new Date(now.getTime() + 61 * 60_000);
    const expired = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, body.access_token);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);

    const elsewhere = await sign({ t: "access", exp: Math.floor(now.getTime() / 1000) + 600, aud: "https://other.example/mcp" }, SECRETS.MCP_SIGNING_KEY);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, elsewhere)).status).toBe(401);
  });

  it("refuses browser origins other than Claude's", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, SECRETS.MCP_TOKEN, { origin: "https://evil.example" })).status).toBe(403);
    const ok = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, SECRETS.MCP_TOKEN, { origin: "https://claude.ai" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
  });
});

describe("protocol", () => {
  it("initialize: echoes a supported version and sends the instructions", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    const { result } = (await res.json()) as { result: { protocolVersion: string; instructions: string; serverInfo: { name: string } } };
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo.name).toBe("trader");
    expect(result.instructions).toContain("preview_strategy before submit_strategy");
  });

  it("notifications → 202; GET/DELETE → 405; bad JSON and unknown versions → 400", async () => {
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    for (const method of ["GET", "DELETE"]) {
      expect((await call("/mcp", { method, headers: { authorization: `Bearer ${SECRETS.MCP_TOKEN}` } })).status).toBe(405);
    }
    const bad = await rpc("{nope");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, SECRETS.MCP_TOKEN, { "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
  });

  it("answers POSTs at / too, and opens no database for non-tool calls", async () => {
    const res = await call("/", { method: "POST", headers: { authorization: `Bearer ${SECRETS.MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(opened).toBe(0);
  });
});

describe("tools", () => {
  it("the list is pinned: reads plus submit_strategy, and nothing that places, cancels or halts orders (ADR-011)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { result } = (await res.json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(result.tools.map((t) => t.name)).toEqual([
      "get_overview",
      "get_strategy",
      "get_holdings",
      "get_activity",
      "get_track_record",
      "get_prices",
      "check_eligibility",
      "get_exposure",
      "get_rules",
      "preview_strategy",
      "submit_strategy",
    ]);
    expect(result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["submit_strategy"]);
    expect(TOOLS.map((t) => t.name).join(" ")).not.toMatch(/order|cancel|kill|resume|halt|trade|buy|sell/);
  });

  it("calls into core over the database, and closes it", async () => {
    const { result } = await tool("get_overview");
    expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ environment: "staging", strategy: { version: 0 } });
    expect([opened, closed]).toEqual([1, 1]);
    expect(logs.find((l) => l.message === "tool")?.detail).toMatchObject({ tool: "get_overview", via: "static", isError: false });
  });

  it("submit_strategy stores Claude's version; a rejection is data, not a failure", async () => {
    const { result } = await tool("submit_strategy", { strategy: { summary: "x" } });
    expect(result!.isError).toBeUndefined();
    expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ status: "rejected" });
  });

  it("bad arguments are protocol errors; a tool's own error is a tool error", async () => {
    expect((await tool("place_order", {})).error).toMatchObject({ code: -32602, message: "Unknown tool: place_order" });
    expect((await tool("get_prices", { symbols: "AAPL" })).error).toMatchObject({ code: -32602 });
    expect((await tool("get_activity", { days: 1.5 })).error).toMatchObject({ code: -32602 });
    expect((await tool("get_prices", { symbols: ["???"] })).result).toMatchObject({ isError: true });
  });

  it("a tool that throws reports a generic failure and logs the detail", async () => {
    broker.getCalendar = async () => {
      throw new Error("connect ECONNREFUSED postgres://secret@host");
    };
    const { result } = await tool("get_overview");
    expect(result).toMatchObject({ isError: true });
    expect(result!.content[0]!.text).not.toContain("secret");
    expect(logs.find((l) => l.message === "tool failed")?.detail).toMatchObject({ tool: "get_overview" });
    expect(closed).toBe(1);
  });
});
