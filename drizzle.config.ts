import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for schema management.");

export default defineConfig({
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
  strict: true,
  verbose: true,
});
