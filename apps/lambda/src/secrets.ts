import { GetParametersCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { ENGINE_PARAMETERS } from "@trader/core";

/**
 * Re-read SSM at most this often per warm container. Each decrypted
 * SecureString is a KMS request; at the tick's own 15 minutes the cache never
 * hit. A rotated secret lands within the hour.
 */
const TTL_MS = 60 * 60_000;

let cache: { path: string; at: number; values: Record<string, string> } | null = null;

/**
 * The engine's parameters (ENGINE_PARAMETERS) under `path` (e.g.
 * `/trader/staging/`), keyed by name (`DATABASE_URL`, `ALPACA_KEY_ID`, …),
 * which is the shape parseConfig validates. A missing one is left out, and
 * parseConfig reports it. Values are never logged.
 */
export async function loadSecrets(ssm: Pick<SSMClient, "send">, path: string, now = Date.now()): Promise<Record<string, string>> {
  if (cache && cache.path === path && now - cache.at < TTL_MS) return cache.values;
  const out = await ssm.send(new GetParametersCommand({ Names: ENGINE_PARAMETERS.map((n) => `${path}${n}`), WithDecryption: true }));
  const values: Record<string, string> = {};
  for (const p of out.Parameters ?? []) if (p.Name && p.Value !== undefined) values[p.Name.slice(path.length)] = p.Value;
  cache = { path, at: now, values };
  return values;
}

/** For tests. */
export function clearSecretsCache(): void {
  cache = null;
}
