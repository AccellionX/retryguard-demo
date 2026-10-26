import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: ["./tests/setup/globalSetup.ts"],
    setupFiles: ["./tests/setup/env.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
