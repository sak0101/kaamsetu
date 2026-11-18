import { defineConfig } from "vitest/config";

// Unit tests only (no database, no Docker). Integration tests need the local
// Supabase stack and run via `npm run test:integration -w @kaamsetu/api`.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["**/*.integration.test.ts", "node_modules/**"] },
});
