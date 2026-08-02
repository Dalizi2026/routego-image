import { configDefaults, defineConfig } from "vitest/config";

const nodeOwnedReleaseTests = [
  "test/package.test.ts",
  "test/install-smoke.test.ts",
  "test/release-workflow.test.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // These scripts are covered by the direct Windows package acceptance job.
    // Vite's Windows transformer cannot load their Node-only ESM source safely.
    exclude: process.platform === "win32"
      ? [...configDefaults.exclude, ...nodeOwnedReleaseTests]
      : configDefaults.exclude,
    fileParallelism: false
  }
});
