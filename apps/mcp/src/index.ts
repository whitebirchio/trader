import { SSMClient } from "@aws-sdk/client-ssm";
import { Pool } from "@neondatabase/serverless";
import { AlpacaBroker, type Db, MarketDataOnly, SecFilings } from "@trader/core";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { fromResponse, toRequest } from "./function-url.js";
import { loadMcpParameters, mcpEnv } from "./secrets.js";
import { createServer } from "./server.js";

// Clients live outside the handler so warm invocations reuse them (and SEC's ticker map).
const ssm = new SSMClient({});
const filings = new SecFilings();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on the function`);
  return value;
}

const server = createServer({
  async loadEnv() {
    return mcpEnv(await loadMcpParameters(ssm, required("SECRETS_PATH")), process.env.TRADING_ENV);
  },
  async openDb(config) {
    // One pool per request: a frozen container's sockets can't be trusted.
    const pool = new Pool({ connectionString: config.databaseUrl });
    return { db: drizzle(pool, { casing: "snake_case" }) as unknown as Db, close: () => pool.end() };
  },
  // Market data only, through the PAPER hosts with the paper key (MCP_ALPACA_*) in
  // every environment: the MCP server never touches an account, so production's
  // holds no live-account credential (review finding R1).
  makeBroker: (config) => new MarketDataOnly(new AlpacaBroker({ env: "staging", keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey })),
  filings,
  now: () => new Date(),
  log: (level, message, detail) => console[level === "error" ? "error" : "log"](JSON.stringify({ level, message, ...detail })),
});

export const handler = async (event: APIGatewayProxyEventV2) => fromResponse(await server(toRequest(event)));
