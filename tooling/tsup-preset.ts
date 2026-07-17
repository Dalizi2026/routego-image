import { defineConfig, type Options } from "tsup";

const baseOptions = {
  entry: ["src/index.ts"],
  tsconfig: "tsconfig.build.json",
  format: ["esm"],
  target: "node20",
  platform: "neutral",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true
} satisfies Options;

export function createPackageConfig(overrides: Options = {}) {
  return defineConfig({
    ...baseOptions,
    ...overrides
  });
}
