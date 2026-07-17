import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const bridgeModuleUrl = `/@fs/${fileURLToPath(
  new URL("./src/dev/vite-mock-bridge.ts", import.meta.url)
).replaceAll("\\", "/")}`;
const mockServiceModuleUrl = `/@fs/${fileURLToPath(
  new URL("../mock-relay/src/service/mock-service.ts", import.meta.url)
).replaceAll("\\", "/")}`;
const defaultMockSessionToken = "routego-studio-synthetic-session-token";

export default defineConfig(() => {
  const mockEnabled = process.env["ROUTEGO_STUDIO_MOCK"] === "1";
  const sessionToken =
    process.env["ROUTEGO_STUDIO_MOCK_SESSION"] ?? defaultMockSessionToken;

  return {
    root: packageRoot,
    plugins: [
      react(),
      ...(mockEnabled
        ? [
            {
              name: "routego-studio-deterministic-mock-loader",
              apply: "serve" as const,
              async configureServer(server: ViteDevServer) {
                const [bridgeModule, mockModule] = await Promise.all([
                  server.ssrLoadModule(bridgeModuleUrl),
                  server.ssrLoadModule(mockServiceModuleUrl)
                ]);
                const install = bridgeModule["installStudioMockBridge"];
                const createService = mockModule["createMockRoutegoService"];
                if (typeof install !== "function" || typeof createService !== "function") {
                  throw new Error("The deterministic Studio mock bridge could not be loaded.");
                }
                install(server.middlewares.use.bind(server.middlewares), {
                  service: createService(),
                  sessionToken
                });
              }
            }
          ]
        : [])
    ],
    resolve: {
      conditions: ["development"]
    },
    ssr: {
      noExternal: ["@routego-image/contracts", "@routego-image/foundation"],
      resolve: { conditions: ["development"] }
    },
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true
    },
    build: {
      outDir: "dist/app",
      emptyOutDir: false
    }
  };
});
