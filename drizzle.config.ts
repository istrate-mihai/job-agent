// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

process.loadEnvFile(".env"); // Node 22 built-in, no dotenv dependency

const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
});
