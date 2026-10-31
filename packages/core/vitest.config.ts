import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // PGlite startup is per-file; keep files parallel but tests sequential.
    fileParallelism: true,
  },
});
