import { GetParametersCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { MCP_PARAMETERS } from "@trader/core";

// MCP_PARAMETERS (core) are the only names loaded. MCP_DATABASE_URL connects as
// trader_mcp (scripts/mcp-role.ts); MCP_ALPACA_* is the paper account's key,
// used only for market data (MarketDataOnly).
export { MCP_PARAMETERS };

/** Re-read SSM at most this often per warm container (each decrypted SecureString is a KMS request); a rotated secret lands within the hour. */
const TTL_MS = 60 * 60_000;
let cache: { path: string; at: number; values: Record<string, string> } | null = null;

/** The parameters under `path` (e.g. `/trader/staging/`), keyed by name. Values are never logged. */
export async function loadMcpParameters(ssm: Pick<SSMClient, "send">, path: string, now = Date.now()): Promise<Record<string, string>> {
  if (cache && cache.path === path && now - cache.at < TTL_MS) return cache.values;
  const out = await ssm.send(new GetParametersCommand({ Names: MCP_PARAMETERS.map((n) => `${path}${n}`), WithDecryption: true }));
  const values: Record<string, string> = {};
  for (const p of out.Parameters ?? []) if (p.Name && p.Value !== undefined) values[p.Name.slice(path.length)] = p.Value;
  cache = { path, at: now, values };
  return values;
}

/** Map the MCP server's parameters onto the names parseConfig and the auth module read. */
export function mcpEnv(values: Record<string, string>, tradingEnv: string | undefined): Record<string, unknown> {
  return {
    TRADING_ENV: tradingEnv,
    DATABASE_URL: values.MCP_DATABASE_URL,
    ALPACA_KEY_ID: values.MCP_ALPACA_KEY_ID,
    ALPACA_SECRET_KEY: values.MCP_ALPACA_SECRET_KEY,
    MCP_TOKEN: values.MCP_TOKEN,
    MCP_PASSPHRASE: values.MCP_PASSPHRASE,
    MCP_SIGNING_KEY: values.MCP_SIGNING_KEY,
  };
}

/** For tests. */
export function clearMcpParameterCache(): void {
  cache = null;
}
