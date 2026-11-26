import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLOSSARY } from "../src/lib/glossary";

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".tsx") ? [join(dir, f)] : []));

describe("the glossary", () => {
  it("has a plain definition for every term", () => {
    for (const e of Object.values(GLOSSARY)) {
      expect(e.term.length).toBeGreaterThan(2);
      expect(e.text.length).toBeGreaterThan(40);
    }
  });

  it("covers every ⓘ on every page, and every term is used somewhere", () => {
    const used = new Set(files(join(__dirname, "..", "src")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/<Info term="(\w+)"/g)].map((m) => m[1]!)));
    for (const t of used) expect(Object.keys(GLOSSARY)).toContain(t);
    expect([...used].sort()).toEqual(Object.keys(GLOSSARY).sort());
  });
});
