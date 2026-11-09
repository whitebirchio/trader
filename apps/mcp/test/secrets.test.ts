import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_PARAMETERS, clearMcpParameterCache, loadMcpParameters, mcpEnv } from "../src/secrets.js";

beforeEach(() => clearMcpParameterCache());

describe("loadMcpParameters", () => {
  it("asks SSM for the MCP server's own parameters by name, never the engine's, and caches them", async () => {
    const asked: string[][] = [];
    const ssm = {
      send: async (command: GetParametersCommand) => {
        asked.push(command.input.Names ?? []);
        return { Parameters: [{ Name: "/trader/staging/MCP_DATABASE_URL", Value: "postgresql://trader_mcp:pw@host/db" }] };
      },
    } as unknown as Parameters<typeof loadMcpParameters>[0];
    expect(await loadMcpParameters(ssm, "/trader/staging/", 0)).toEqual({ MCP_DATABASE_URL: "postgresql://trader_mcp:pw@host/db" });
    expect(asked).toEqual([MCP_PARAMETERS.map((n) => `/trader/staging/${n}`)]);
    expect(asked[0]!.some((n) => /\/(DATABASE_URL|ALPACA_KEY_ID|ALPACA_SECRET_KEY)$/.test(n))).toBe(false);
    await loadMcpParameters(ssm, "/trader/staging/", 60_000);
    expect(asked).toHaveLength(1);
  });
});

describe("mcpEnv", () => {
  it("maps the MCP parameters onto the names parseConfig and the auth module read", () => {
    expect(mcpEnv({ MCP_DATABASE_URL: "db", MCP_ALPACA_KEY_ID: "k", MCP_ALPACA_SECRET_KEY: "s", MCP_TOKEN: "t", MCP_PASSPHRASE: "p", MCP_SIGNING_KEY: "g" }, "production")).toEqual({
      TRADING_ENV: "production",
      DATABASE_URL: "db",
      ALPACA_KEY_ID: "k",
      ALPACA_SECRET_KEY: "s",
      MCP_TOKEN: "t",
      MCP_PASSPHRASE: "p",
      MCP_SIGNING_KEY: "g",
    });
  });
});
