import { defineConfig, type ViteUserConfig } from "vitest/config";

export function createVitestConfig(overrides: ViteUserConfig = {}) {
  return defineConfig({
    test: {
      environment: "node",
      globals: false,
      passWithNoTests: false,
      restoreMocks: true,
      clearMocks: true,
      mockReset: true,
      coverage: {
        provider: "v8",
        reporter: ["text", "json-summary"]
      }
    },
    ...overrides
  });
}
