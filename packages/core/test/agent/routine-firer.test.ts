import { describe, expect, it } from "vitest";
import { AnthropicRoutineFirer, fireRequest } from "../../src/agent/routine-firer.js";

const TRIGGER = "trig_01ABCDEFGHJKLMNOPQRSTUVW";
const TOKEN = "sk-ant-oat01-secret-token-value";

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal } };

function fakeFetch(respond: (call: Call) => Promise<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    const r = await respond({ url, init });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { fn, calls };
}

describe("fireRequest", () => {
  it("posts the text to the routine's fire endpoint, and prints without the token", () => {
    const req = fireRequest(TRIGGER, TOKEN, "Automatic retry 1");
    expect(req.url).toBe(`https://api.anthropic.com/v1/claude_code/routines/${TRIGGER}/fire`);
    expect(req.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(JSON.parse(req.body)).toEqual({ text: "Automatic retry 1" });
    expect(JSON.stringify(fireRequest(TRIGGER, null, "x"))).not.toContain("sk-ant");
  });
});

describe("AnthropicRoutineFirer", () => {
  it("returns the new session's link", async () => {
    const f = fakeFetch(async () => ({ status: 200, body: { type: "routine_fire", claude_code_session_id: "session_01", claude_code_session_url: "https://claude.ai/code/session_01" } }));
    const result = await new AnthropicRoutineFirer({ [TRIGGER]: TOKEN }, f.fn).fire(TRIGGER, "retry");
    expect(result).toEqual({ status: "fired", sessionUrl: "https://claude.ai/code/session_01" });
    expect(f.calls[0]!.init.method).toBe("POST");
  });

  it("reports refusals by status and error type, never with the token", async () => {
    for (const [status, type] of [[401, "authentication_error"], [429, "rate_limit_error"], [503, "overloaded_error"]] as const) {
      const f = fakeFetch(async () => ({ status, body: { type: "error", error: { type, message: `bad ${TOKEN}` } } }));
      const result = await new AnthropicRoutineFirer({ [TRIGGER]: TOKEN }, f.fn).fire(TRIGGER, "retry");
      expect(result).toEqual({ status: "failed", httpStatus: status, errorType: type });
      expect(JSON.stringify(result)).not.toContain("sk-ant");
    }
    const html = fakeFetch(async () => ({ status: 502, body: null }));
    expect(await new AnthropicRoutineFirer({ [TRIGGER]: TOKEN }, html.fn).fire(TRIGGER, "retry")).toEqual({ status: "failed", httpStatus: 502, errorType: "http_502" });
  });

  it("gives up after its timeout, and on a network error, without the message", async () => {
    const hang = fakeFetch(
      ({ init }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error(`aborted ${TOKEN}`), { name: "TimeoutError" })));
        }),
    );
    expect(await new AnthropicRoutineFirer({ [TRIGGER]: TOKEN }, hang.fn, 20).fire(TRIGGER, "retry")).toEqual({ status: "failed", httpStatus: null, errorType: "timeout" });
    const down = fakeFetch(async () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    });
    expect(await new AnthropicRoutineFirer({ [TRIGGER]: TOKEN }, down.fn).fire(TRIGGER, "retry")).toEqual({ status: "failed", httpStatus: null, errorType: "network_error" });
  });

  it("doesn't call without a token for that routine", async () => {
    const f = fakeFetch(async () => ({ status: 200, body: {} }));
    expect(await new AnthropicRoutineFirer({}, f.fn).fire(TRIGGER, "retry")).toEqual({ status: "failed", httpStatus: null, errorType: "no_token" });
    expect(f.calls).toHaveLength(0);
  });
});
