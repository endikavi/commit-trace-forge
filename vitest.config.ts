import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Container-backed integration tests build images and run real suites.
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    // Containers and the workspace database are shared state; run files one at a time.
    fileParallelism: false,
    pool: "forks",
    reporters: ["default"],
  },
});
