import { GetParametersByPathCommand, type SSMClient } from "@aws-sdk/client-ssm";

/** Re-read SSM at most this often per warm container, so a rotated secret lands within minutes. */
const TTL_MS = 15 * 60_000;

let cache: { path: string; at: number; values: Record<string, string> } | null = null;

/**
 * Every SecureString under `path` (e.g. `/trader/staging/`), keyed by its last
 * segment (`DATABASE_URL`, `ALPACA_KEY_ID`, …), which is the shape parseConfig
 * validates. Values are never logged.
 */
export async function loadSecrets(ssm: SSMClient, path: string, now = Date.now()): Promise<Record<string, string>> {
  if (cache && cache.path === path && now - cache.at < TTL_MS) return cache.values;
  const values: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: path, WithDecryption: true, Recursive: false, NextToken }));
    for (const p of page.Parameters ?? []) {
      const key = p.Name?.slice(path.length);
      if (key && p.Value !== undefined) values[key] = p.Value;
    }
    NextToken = page.NextToken;
  } while (NextToken);
  cache = { path, at: now, values };
  return values;
}

/** For tests. */
export function clearSecretsCache(): void {
  cache = null;
}
