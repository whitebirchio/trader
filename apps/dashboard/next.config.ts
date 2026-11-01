import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server for the Lambda Web Function (scripts/package.mjs).
  output: "standalone",
  // Trace from the repo root so the workspace's @trader/core is included.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  transpilePackages: ["@trader/core"],
  poweredByHeader: false,
  // @trader/core is TypeScript source with NodeNext-style ".js" import paths.
  // Turbopack doesn't map those onto ".ts" files; webpack does, so the
  // dashboard builds with webpack (`next build --webpack`).
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
