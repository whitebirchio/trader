import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/**
 * Lambda Function URL events <-> Web Request/Response, so the server is plain
 * fetch-style code that tests drive directly. The URL is rebuilt from the
 * Function URL's own domain, which is what binds OAuth tokens to this server.
 */
export function toRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const hasBody = event.body !== undefined && method !== "GET" && method !== "HEAD";
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, "base64") : event.body) : undefined;
  return new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`, { method, headers, body });
}

export async function fromResponse(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { statusCode: response.status, headers, body: await response.text(), isBase64Encoded: false };
}
