import { createPackageConfig } from "../../tooling/tsup-preset";

const pluginBundle = process.env["ROUTEGO_PLUGIN_BUNDLE"] === "1";

export default createPackageConfig({
  platform: "node",
  ...(pluginBundle
    ? {
        sourcemap: false,
        noExternal: [/.*/u],
        dts: false,
        banner: {
          js: 'import { createRequire as __routegoCreateRequire } from "node:module";\nconst require = __routegoCreateRequire(import.meta.url);'
        },
        esbuildOptions(options) {
          options.conditions = ["development"];
        }
      }
    : {})
});
