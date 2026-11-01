import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { fromResponse, toRequest } from "../src/function-url.js";

const event = (over: Partial<APIGatewayProxyEventV2> & { method?: string } = {}) =>
  ({
    rawPath: "/authorize",
    rawQueryString: "a=1&b=2",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "ignored.example" },
    requestContext: { domainName: "abc123.lambda-url.us-east-1.on.aws", http: { method: over.method ?? "POST" } },
    body: "passphrase=x",
    isBase64Encoded: false,
    ...over,
  }) as unknown as APIGatewayProxyEventV2;

describe("Function URL adapter", () => {
  it("rebuilds the request on the Function URL's own domain", async () => {
    const req = toRequest(event());
    expect(req.url).toBe("https://abc123.lambda-url.us-east-1.on.aws/authorize?a=1&b=2");
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(await req.text()).toBe("passphrase=x");
  });

  it("decodes base64 bodies and drops bodies on GET", async () => {
    expect(await toRequest(event({ body: Buffer.from("{}").toString("base64"), isBase64Encoded: true })).text()).toBe("{}");
    expect(toRequest(event({ method: "GET" })).body).toBeNull();
  });

  it("turns a Response into a Function URL result", async () => {
    const out = await fromResponse(new Response(null, { status: 302, headers: { location: "https://claude.ai/cb?code=c" } }));
    expect(out).toEqual({ statusCode: 302, headers: { location: "https://claude.ai/cb?code=c" }, body: "", isBase64Encoded: false });
  });
});
