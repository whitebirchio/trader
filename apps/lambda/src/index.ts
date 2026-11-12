import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { Pool } from "@neondatabase/serverless";
import { AlpacaBroker, AlphaVantageCalendar, AlphaVantageEarnings, type Db, SecFilings } from "@trader/core";
import { drizzle } from "drizzle-orm/neon-serverless";
import { createHandler } from "./handler.js";
import { loadSecrets } from "./secrets.js";
import { SesMailer } from "./ses-mailer.js";

// Clients live outside the handler so warm invocations reuse them.
const ssm = new SSMClient({});
const ses = new SESv2Client({});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on the function`);
  return value;
}

export const handler = createHandler({
  async loadEnv() {
    const secrets = await loadSecrets(ssm, required("SECRETS_PATH"));
    return { ...secrets, TRADING_ENV: process.env.TRADING_ENV };
  },
  async openDb(config) {
    // One pool per invocation: a frozen container's sockets can't be trusted (Node 22 has a global WebSocket).
    const pool = new Pool({ connectionString: config.databaseUrl });
    return { db: drizzle(pool, { casing: "snake_case" }) as unknown as Db, close: () => pool.end() };
  },
  makeBroker: (config) => new AlpacaBroker({ env: config.tradingEnv, keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey }),
  makeMailer: () => new SesMailer(ses, required("NOTIFY_FROM"), required("NOTIFY_TO")),
  filings: new SecFilings(),
  makeEarnings: (config) => (config.alphaVantageKey ? new AlphaVantageCalendar(config.alphaVantageKey) : undefined),
  makeEarningsHistory: (config) => (config.alphaVantageKey ? new AlphaVantageEarnings(config.alphaVantageKey) : undefined),
  now: () => new Date(),
  log: (level, message, detail) => console[level === "error" ? "error" : "log"](JSON.stringify({ level, message, ...detail })),
});
