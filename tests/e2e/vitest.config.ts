import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "**/*.test.ts",
      "integration/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/fixtures/**/node_modules/**",
    ],
    testTimeout: 360_000,  // 360s — workflow lifecycle tests wait up to 5 min for LLM execution
    hookTimeout: 360_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["verbose"],
  },
});
