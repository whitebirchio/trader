import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SIGNED_IN = join(__dirname, "..", "src", "app", "(signed-in)");
const pages = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? pages(join(dir, f)) : f === "page.tsx" ? [join(dir, f)] : []));

describe("signed-in pages", () => {
  it("are all rendered per request: none is prerendered at build or cached (SPEC-dashboard § Boundaries)", () => {
    const missing = pages(SIGNED_IN).filter((p) => !/export const dynamic = "force-dynamic"/.test(readFileSync(p, "utf8")));
    expect(missing).toEqual([]);
  });
});
