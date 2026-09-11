import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/realPostgres.requirement.ts"],
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.ts", "test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    hookTimeout: process.env.CONTROL_API_REAL_PG_ADMIN_URL ? 60_000 : 10_000,
  },
});
