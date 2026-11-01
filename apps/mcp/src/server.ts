// Trader's MCP server (SPEC-agent), as a Web Request -> Response function.
//
// The routing is ported from Fred's MCP Worker (~/fred/mcp-worker.ts, Scott's
// own code): discovery, OAuth, then one stateless JSON-RPC endpoint. It's a
// thin shell over @trader/core (ADR-002). It has no order tools (ADR-011),
// and it fails closed: no usable secret means no access, and bad config means
// no tools.

import { type BrokerAdapter, type Config, type Db, type ToolDeps, parseConfig } from "@trader/core";
import {
  type AuthEnv,
  authSecrets,
  authenticate,
  authorizationServerMetadata,
  checkAuthorize,
  errorPage,
  exchangeToken,
  grantCode,
  passphrasePage,
  protectedResourceMetadata,
  registerClient,
  serverUrls,
  timingSafeEqual,
  unauthorized,
} from "./auth.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import {
  LATEST_PROTOCOL_VERSION,
  type MethodTable,
  RpcCode,
  RpcException,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleRpcPost,
  json,
  originAllowed,
  protocolVersionOf,
} from "./protocol.js";
import { callTool, toolDescriptors } from "./tools.js";

export interface ServerDeps {
  /** TRADING_ENV plus this environment's SSM secrets (MCP_* included). */
  loadEnv(): Promise<Record<string, unknown>>;
  openDb(config: Config): Promise<{ db: Db; close(): Promise<void> }>;
  makeBroker(config: Config): BrokerAdapter;
  now(): Date;
  log(level: "info" | "error", message: string, detail?: Record<string, unknown>): void;
}

const SERVER_INFO = { name: "trader", title: "Trader: autonomous portfolio", version: "1.0.0" };

/** Browser origins permitted to talk to this endpoint. Non-browser clients send
 *  no Origin at all and are unaffected; this only closes the DNS-rebinding hole
 *  the transport spec warns about. */
const ALLOWED_ORIGINS = ["https://claude.ai", "https://www.claude.ai", "https://claude.com", "https://www.claude.com"];

/** CORS for browser-based clients. Credentials are never cookie-based here, so
 *  echoing the (already validated) origin is safe. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "mcp-session-id, www-authenticate",
    "access-control-max-age": "86400",
  };
}

const withHeaders = (response: Response, extra: Record<string, string>) => {
  if (Object.keys(extra).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function rpcMethods(callToolWithDeps: (name: string, args: unknown) => Promise<unknown>): MethodTable {
  return {
    initialize(params) {
      const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "";
      return {
        // Echo the client's version whenever we speak it.
        protocolVersion: (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      };
    },
    "notifications/initialized": () => null,
    "notifications/cancelled": () => null,
    ping: () => ({}),
    "tools/list": () => ({ tools: toolDescriptors() }),
    "tools/call": (params) => {
      const p = (params ?? {}) as { name?: string; arguments?: unknown };
      if (!p.name) throw new RpcException(RpcCode.InvalidParams, "tools/call requires a name");
      return callToolWithDeps(p.name, p.arguments);
    },
    "resources/list": () => ({ resources: [] }),
    "resources/templates/list": () => ({ resourceTemplates: [] }),
    "prompts/list": () => ({ prompts: [] }),
  };
}

export function createServer(deps: ServerDeps) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const urls = serverUrls(request);
    const cors = corsHeaders(request);
    const respond = (r: Response) => withHeaders(r, cors);

    if (request.method === "OPTIONS") return respond(new Response(null, { status: 204 }));

    const env = await deps.loadEnv();
    const authEnv: AuthEnv = {
      MCP_TOKEN: typeof env.MCP_TOKEN === "string" ? env.MCP_TOKEN : undefined,
      MCP_PASSPHRASE: typeof env.MCP_PASSPHRASE === "string" ? env.MCP_PASSPHRASE : undefined,
      MCP_SIGNING_KEY: typeof env.MCP_SIGNING_KEY === "string" ? env.MCP_SIGNING_KEY : undefined,
    };
    const secrets = authSecrets(authEnv);

    // Fail closed: without a way to authenticate, serve nothing.
    if (!secrets.signingKey && !secrets.token) {
      deps.log("error", "mcp not configured: no usable MCP_SIGNING_KEY or MCP_TOKEN");
      return respond(text("Trader MCP is not configured. Run scripts/set-mcp-secrets.sh for this environment.", 503));
    }

    // --- Discovery ---------------------------------------------------------
    // Serve both the path-suffixed and bare RFC 9728 forms; clients probe either.
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return respond(json(protectedResourceMetadata(urls)));
    }
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return respond(json(authorizationServerMetadata(urls)));
    }

    // --- OAuth -------------------------------------------------------------
    const { signingKey } = secrets;

    if (url.pathname === "/register" && request.method === "POST") {
      if (!signingKey) return respond(json({ error: "server_error" }, 500));
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return respond(json({ error: "invalid_client_metadata" }, 400));
      }
      const result = await registerClient(body, urls, signingKey, deps.now().getTime());
      return respond(json(result.body, result.ok ? 201 : result.status));
    }

    if (url.pathname === "/authorize") {
      if (!signingKey || !secrets.passphrase) {
        return respond(errorPage("This server has no passphrase configured, so it cannot grant access. Run scripts/set-mcp-secrets.sh.", 503));
      }
      const query = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams;
      const now = deps.now().getTime();
      const check = await checkAuthorize(query, urls, signingKey, now);
      if (!check.ok) return respond("redirect" in check ? redirect(check.redirect) : errorPage(check.render, check.status));

      // GET shows the form; POST is the submission.
      if (request.method !== "POST") return respond(passphrasePage(query));

      if (!timingSafeEqual(query.get("passphrase") ?? "", secrets.passphrase)) {
        deps.log("info", "mcp authorize: wrong passphrase");
        return respond(passphrasePage(query, "That passphrase is not correct."));
      }
      deps.log("info", "mcp authorize: granted");
      return respond(redirect(await grantCode(check.params, urls, signingKey, now)));
    }

    if (url.pathname === "/token" && request.method === "POST") {
      if (!signingKey) return respond(json({ error: "server_error" }, 500));
      const result = await exchangeToken(new URLSearchParams(await request.text()), urls, signingKey, deps.now().getTime());
      return respond(json(result.body, result.ok ? 200 : result.status, { "cache-control": "no-store" }));
    }

    // --- MCP ---------------------------------------------------------------
    // Also answer POSTs at "/": connector dialogs are often given the base URL.
    // Tokens are bound to `<origin>/mcp` either way (serverUrls ignores the path).
    const isMcpEndpoint = url.pathname === "/mcp" || (url.pathname === "/" && request.method === "POST");

    if (isMcpEndpoint) {
      if (!originAllowed(request, ALLOWED_ORIGINS)) return respond(new Response("Origin not allowed", { status: 403 }));

      const auth = await authenticate(request, authEnv, urls, deps.now().getTime());
      if (!auth.ok) {
        deps.log("info", "mcp unauthorized", { reason: auth.reason });
        return respond(unauthorized(urls, auth.reason));
      }

      // Stateless: no session to stream on and none to delete.
      if (request.method !== "POST") return respond(new Response(null, { status: 405, headers: { allow: "POST, OPTIONS" } }));

      if (protocolVersionOf(request) === null) {
        return respond(json({ error: "unsupported_protocol_version", error_description: `Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}` }, 400));
      }

      // Names only, never values (as the engine does).
      const parsed = parseConfig(env);
      if (!parsed.ok) {
        deps.log("error", "config invalid; tools unavailable", { missing: parsed.missing, invalid: parsed.invalid });
        return respond(json({ error: "misconfigured", missing: parsed.missing, invalid: parsed.invalid }, 503));
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return respond(json({ jsonrpc: "2.0", id: null, error: { code: RpcCode.ParseError, message: "Invalid JSON" } }, 400));
      }

      // One DB pool per request, opened only if a tool runs.
      const { config } = parsed;
      let session: { db: Db; close(): Promise<void> } | null = null;
      const toolDeps = async (): Promise<ToolDeps> => {
        session ??= await deps.openDb(config);
        return { db: session.db, broker: deps.makeBroker(config), env: config.tradingEnv, now: deps.now() };
      };
      const methods = rpcMethods(async (name, args) => {
        const started = Date.now();
        try {
          const result = await callTool(name, args, toolDeps);
          deps.log("info", "tool", { tool: name, via: auth.via, ms: Date.now() - started, isError: "isError" in result });
          return result;
        } catch (err) {
          if (err instanceof RpcException) throw err;
          // A tool that blew up is a tool-level failure, not a protocol one:
          // report it inside the result so the model can adapt.
          deps.log("error", "tool failed", { tool: name, error: err instanceof Error ? err.message : String(err) });
          return { isError: true, content: [{ type: "text", text: `Tool ${name} failed. The owner can see the details in the server logs.` }] };
        }
      });
      try {
        return respond(await handleRpcPost(body, methods));
      } finally {
        await (session as { close(): Promise<void> } | null)?.close();
      }
    }

    // --- Landing -----------------------------------------------------------
    if (url.pathname === "/" && request.method === "GET") {
      return respond(text(`Trader MCP server\n\nEndpoint: ${urls.resource}\n\nAdd it in Claude under Settings -> Connectors -> Add custom connector.\n`));
    }

    return respond(text("Not found", 404));
  };
}
