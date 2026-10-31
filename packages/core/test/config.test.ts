import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const SECRET_URL = "postgresql://trader_app:s3cretPassw0rd@ep-x-pooler.us-east-2.aws.neon.tech/neondb";

describe("parseConfig", () => {
  it("accepts a valid environment", () => {
    const result = parseConfig({ TRADING_ENV: "staging", DATABASE_URL: SECRET_URL });
    expect(result).toEqual({
      ok: true,
      config: { tradingEnv: "staging", databaseUrl: SECRET_URL },
    });
  });

  it("accepts postgres:// as well as postgresql://", () => {
    const url = SECRET_URL.replace("postgresql://", "postgres://");
    const result = parseConfig({ TRADING_ENV: "production", DATABASE_URL: url });
    expect(result.ok).toBe(true);
  });

  it("reports missing vars by name", () => {
    const result = parseConfig({});
    expect(result).toEqual({ ok: false, missing: ["DATABASE_URL", "TRADING_ENV"], invalid: [] });
  });

  it("treats an empty string as missing", () => {
    const result = parseConfig({ TRADING_ENV: "staging", DATABASE_URL: "" });
    expect(result).toEqual({ ok: false, missing: ["DATABASE_URL"], invalid: [] });
  });

  it("reports invalid vars by name", () => {
    const result = parseConfig({ TRADING_ENV: "live", DATABASE_URL: "mysql://nope" });
    expect(result).toEqual({ ok: false, missing: [], invalid: ["DATABASE_URL", "TRADING_ENV"] });
  });

  it("never echoes a secret value in a failure", () => {
    const result = parseConfig({ TRADING_ENV: "bogus", DATABASE_URL: SECRET_URL });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("s3cretPassw0rd");
    expect(JSON.stringify(result)).not.toContain("bogus");
  });
});
