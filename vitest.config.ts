// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    env: {
      // src/db/client.ts requires it at import time; no test opens a connection
      DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
      GROQ_API_KEY: "test-key",
      GEMINI_API_KEY: "test-key",
    },
  },
});
