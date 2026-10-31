import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const SECRET_URL = "postgresql://trader_app:s3cretPassw0rd@ep-x-pooler.us-east-2.aws.neon.tech/neondb";
const KEY_ID = "PKTESTKEY0000000000000000A";
const SECRET_KEY = "s3cretAlpacaSecretKey000000000000000000000000";

const valid = {
  TRADING_ENV: "staging",
  DATABASE_URL: SECRET_URL,
  ALPACA_KEY_ID: KEY_ID,
  ALPACA_SECRET_KEY: SECRET_KEY,
};

describe("parseConfig", () => {
  it("accepts a valid environment", () => {
    expect(parseConfig(valid)).toEqual({
      ok: true,
      config: {
        tradingEnv: "staging",
        databaseUrl: SECRET_URL,
        alpaca: { keyId: KEY_ID, secretKey: SECRET_KEY },
      },
    });
  });

  it("accepts postgres:// as well as postgresql://", () => {
    const url = SECRET_URL.replace("postgresql://", "postgres://");
    expect(parseConfig({ ...valid, TRADING_ENV: "production", DATABASE_URL: url }).ok).toBe(true);
  });

  it("reports missing vars by name", () => {
    expect(parseConfig({})).toEqual({
      ok: false,
      missing: ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY", "DATABASE_URL", "TRADING_ENV"],
      invalid: [],
    });
  });

  it("treats an empty string as missing", () => {
    expect(parseConfig({ ...valid, DATABASE_URL: "" })).toEqual({
      ok: false,
      missing: ["DATABASE_URL"],
      invalid: [],
    });
  });

  it("reports invalid vars by name", () => {
    expect(
      parseConfig({ ...valid, TRADING_ENV: "live", DATABASE_URL: "mysql://nope", ALPACA_KEY_ID: "pk-lower" }),
    ).toEqual({ ok: false, missing: [], invalid: ["ALPACA_KEY_ID", "DATABASE_URL", "TRADING_ENV"] });
  });

  it("never echoes a secret value in a failure", () => {
    const result = parseConfig({ ...valid, TRADING_ENV: "bogus", ALPACA_SECRET_KEY: "short" });
    expect(result.ok).toBe(false);
    const json = JSON.stringify(result);
    for (const secret of ["s3cretPassw0rd", "bogus", "short", KEY_ID]) expect(json).not.toContain(secret);
  });
});
