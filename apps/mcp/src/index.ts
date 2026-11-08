import { SSMClient } from "@aws-sdk/client-ssm";
import { Pool } from "@neondatabase/serverless";
import { AlpacaBroker, type Db, SecFilings } from "@trader/core";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { loadSecrets } from "trader-lambda/secrets";
import { fromResponse, toRequest } from "./function-url.js";
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
    const secrets = await loadSecrets(ssm, required("SECRETS_PATH"));
    return { ...secrets, TRADING_ENV: process.env.TRADING_ENV };
  },
  async openDb(config) {
    // One pool per request: a frozen container's sockets can't be trusted.
    const pool = new Pool({ connectionString: config.databaseUrl });
    return { db: drizzle(pool, { casing: "snake_case" }) as unknown as Db, close: () => pool.end() };
  },
  makeBroker: (config) => new AlpacaBroker({ env: config.tradingEnv, keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey }),
  filings,
  now: () => new Date(),
  log: (level, message, detail) => console[level === "error" ? "error" : "log"](JSON.stringify({ level, message, ...detail })),
});

export const handler = async (event: APIGatewayProxyEventV2) => fromResponse(await server(toRequest(event)));
