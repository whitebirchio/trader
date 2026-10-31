/** Read KEY=value pairs from the repo-root .env (quoted or not) without exporting them. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function readRepoEnv(): { get(name: string): string | undefined; require(name: string): string } {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) values.set(m[1], (m[2] ?? "").replace(/^["']|["']$/g, ""));
  }
  return {
    get: (name) => values.get(name),
    require(name) {
      const v = values.get(name);
      if (!v) throw new Error(`${name} is not set in .env`);
      return v;
    },
  };
}
