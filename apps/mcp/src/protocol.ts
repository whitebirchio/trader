// ---------------------------------------------------------------------------
// MCP Streamable HTTP transport (spec 2025-06-18), stateless.
//
// Ported from Fred (~/fred/src/mcp/protocol.ts, Scott's own code) with only
// the comments adapted: a few hundred lines of JSON-RPC over one POST
// endpoint, with no session store and no SSE stream. A tools/call is a request
// and a response.
//
//   POST /mcp with a JSON-RPC *request*      -> 200 application/json
//   POST /mcp with a notification/response   -> 202 Accepted, empty body
//   GET  /mcp, DELETE /mcp                   -> 405 (no stream, no sessions)
//   Origin validated on every request; MCP-Protocol-Version honoured when sent.
// ---------------------------------------------------------------------------

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** What a client that sends no MCP-Protocol-Version header is assumed to speak,
 *  per the transport spec's backwards-compatibility rule. */
export const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC 2.0 -------------------------------------------------------------

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export const enum RpcCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

/** Thrown by handlers to produce a specific JSON-RPC error rather than a
 *  generic internal one. Message text reaches the client, so it must stay free
 *  of anything sensitive. */
export class RpcException extends Error {
  constructor(
    readonly code: RpcCode | number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcException";
  }
}

const result = (id: JsonRpcId, value: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result: value,
});

const failure = (id: JsonRpcId, error: JsonRpcError) => ({
  jsonrpc: "2.0" as const,
  id,
  error,
});

export const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// Request handling ---------------------------------------------------------

/** A method implementation. */
export type MethodHandler = (params: unknown) => Promise<unknown> | unknown;

export type MethodTable = Record<string, MethodHandler>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Origin check (transport spec, security warning #1). Browsers attach Origin to
 * cross-site requests; a DNS-rebinding attacker's page would therefore arrive
 * with an origin we never allow. Non-browser clients — Claude's connector
 * backend, Claude Code, curl — send no Origin at all, which is not something an
 * attacker's page can imitate, so absence is accepted.
 */
export function originAllowed(request: Request, allowed: string[]): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return allowed.includes(origin);
}

/** Reject a protocol version we do not speak (spec: MUST 400). */
export function protocolVersionOf(request: Request): string | null {
  const raw = request.headers.get("mcp-protocol-version");
  if (!raw) return ASSUMED_PROTOCOL_VERSION;
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(raw)
    ? raw
    : null;
}

/**
 * Dispatch one POST body. Returns the Response to send.
 *
 * The spec allows a single JSON-RPC message per POST; batching was removed in
 * 2025-06-18. Older clients may still send an array, so an array is accepted
 * and answered with an array of the non-notification results.
 */
export async function handleRpcPost(
  body: unknown,
  methods: MethodTable,
): Promise<Response> {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) {
    return json(
      failure(null, { code: RpcCode.InvalidRequest, message: "Empty batch" }),
      400,
    );
  }

  const replies: unknown[] = [];
  for (const message of messages) {
    const reply = await dispatch(message, methods);
    if (reply) replies.push(reply);
  }

  // Every message was a notification or response: 202 with no body, per spec.
  if (replies.length === 0) return new Response(null, { status: 202 });

  return json(Array.isArray(body) ? replies : replies[0]);
}

async function dispatch(
  message: unknown,
  methods: MethodTable,
): Promise<unknown | null> {
  if (!isRecord(message) || typeof message.method !== "string") {
    // A JSON-RPC *response* (has result/error, no method) is a legal thing for a
    // client to POST; we never send requests, so there is nothing to correlate
    // it with. Accept and ignore rather than erroring.
    if (isRecord(message) && ("result" in message || "error" in message)) {
      return null;
    }
    return failure(null, {
      code: RpcCode.InvalidRequest,
      message: "Not a JSON-RPC request",
    });
  }

  // No `id` means notification: do the work, answer nothing.
  const isNotification = !("id" in message) || message.id === undefined;
  const id = (isNotification ? null : message.id) as JsonRpcId;

  const handler = methods[message.method];
  if (!handler) {
    if (isNotification) return null;
    return failure(id, {
      code: RpcCode.MethodNotFound,
      message: `Unknown method: ${message.method}`,
    });
  }

  try {
    const value = await handler(message.params);
    return isNotification ? null : result(id, value);
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof RpcException) {
      return failure(id, {
        code: err.code,
        message: err.message,
        data: err.data,
      });
    }
    // Anything unplanned: log it, and return a generic message so a database
    // error can never leak connection details to a client.
    console.error(`mcp ${message.method} failed:`, err);
    return failure(id, {
      code: RpcCode.InternalError,
      message: "Internal error",
    });
  }
}
