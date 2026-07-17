import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@routego-image/mock-relay": fileURLToPath(
        new URL("../mock-relay/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    fileParallelism: false
  }
});
