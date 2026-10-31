import { defineConfig } from "drizzle-kit";

// `generate` works offline; `migrate`/`push` need DATABASE_URL. The getter
// defers the check so generate keeps working without a database configured.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    get url(): string {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set (owner-role Neon URL; see docs/SETUP.md).");
      return url;
    },
  },
});
