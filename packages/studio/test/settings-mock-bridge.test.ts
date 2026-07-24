import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

import { HttpStudioGateway, InMemoryStudioSession } from "../src/api";

const SESSION_TOKEN = "routego-studio-synthetic-settings-session";
let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  delete process.env["ROUTEGO_STUDIO_MOCK"];
  delete process.env["ROUTEGO_STUDIO_MOCK_SESSION"];
});

async function startSettingsBridge(): Promise<string> {
  process.env["ROUTEGO_STUDIO_MOCK"] = "1";
  process.env["ROUTEGO_STUDIO_MOCK_SESSION"] = SESSION_TOKEN;
  server = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null;
  if (address === null) throw new Error("settings mock bridge did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("Settings lifecycle through the deterministic Studio bridge", () => {
  it("keeps profile secrets and output paths write-only while refreshing models without probes", async () => {
    const baseUrl = await startSettingsBridge();
    const gateway = new HttpStudioGateway({
      baseUrl,
      session: new InMemoryStudioSession(SESSION_TOKEN)
    });
    const initial = await gateway.invoke("readSettings", {});
    expect(initial.profiles[0]).toMatchObject({
      id: "mock-provider",
      hasApiKey: true,
      apiKeyPreview: "mock-present"
    });

    const replacement = "synthetic-settings-one-shot-secret";
    const created = await gateway.invoke("upsertProviderProfile", {
      name: "Synthetic alternate relay",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          value: "https://alternate.example.invalid/v1/images/generations"
        }
      },
      defaultModel: "synthetic-image-model-v2",
      apiKey: { operation: "replace", value: replacement },
      setActive: false
    });
    expect(created.profile).toMatchObject({ hasApiKey: true, isActive: false });
    expect(JSON.stringify(created)).not.toContain(replacement);

    const activated = await gateway.invoke("setActiveProviderProfile", {
      profileId: created.profile.id
    });
    expect(activated).toMatchObject({
      activeProviderId: created.profile.id,
      profile: { isActive: true }
    });

    const cleared = await gateway.invoke("upsertProviderProfile", {
      profileId: created.profile.id,
      name: "Synthetic alternate relay updated",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          value: "https://alternate.example.invalid/v1/images/generations"
        }
      },
      defaultModel: "synthetic-image-model-v2",
      apiKey: { operation: "clear" },
      setActive: true
    });
    expect(cleared.profile).toMatchObject({ hasApiKey: false, isActive: true });

    const refreshed = await gateway.invoke("refreshModels", {
      providerId: created.profile.id
    });
    expect(refreshed).toMatchObject({ status: "succeeded", billable: false });
    expect(refreshed.models.length).toBeGreaterThan(0);

    const localCandidate = "/synthetic/private-parent/routego-settings-output";
    const updated = await gateway.invoke("updateSettings", {
      defaults: {
        ...initial.defaults,
        model: refreshed.models[0],
        quality: "high",
        count: 2
      },
      outputDirectory: {
        operation: "replace",
        path: localCandidate,
        confirmLocalPath: true
      }
    });
    expect(updated).toMatchObject({
      activeProviderId: created.profile.id,
      defaults: { quality: "high", count: 2 },
      outputDirectory: { configured: true }
    });
    expect(JSON.stringify(updated)).not.toContain(localCandidate);

    const unchangedOutput = await gateway.invoke("updateSettings", {
      outputDirectory: { operation: "unchanged" }
    });
    expect(unchangedOutput.outputDirectory).toEqual(updated.outputDirectory);

    const clearedOutput = await gateway.invoke("updateSettings", {
      outputDirectory: { operation: "clear" }
    });
    expect(clearedOutput.outputDirectory).toEqual({ configured: false });

    const defaultOutput = await gateway.invoke("updateSettings", {
      outputDirectory: { operation: "default" }
    });
    expect(defaultOutput.outputDirectory).toEqual({
      configured: true,
      display: "Default Pictures/routego-image"
    });

    const restoredOutput = await gateway.invoke("updateSettings", {
      outputDirectory: {
        operation: "replace",
        path: localCandidate,
        confirmLocalPath: true
      }
    });
    expect(JSON.stringify(restoredOutput)).not.toContain(localCandidate);
    expect(await gateway.invoke("readSettings", {})).toEqual(restoredOutput);

    const removed = await gateway.invoke("removeProviderProfile", {
      profileId: "mock-provider"
    });
    expect(removed.removedProfileId).toBe("mock-provider");
    const finalSettings = await gateway.invoke("readSettings", {});
    expect(finalSettings.profiles.map((profile) => profile.id)).toEqual([
      created.profile.id
    ]);
    const serialized = JSON.stringify({
      created,
      activated,
      cleared,
      refreshed,
      updated,
      unchangedOutput,
      clearedOutput,
      defaultOutput,
      restoredOutput,
      finalSettings
    });
    expect(serialized).not.toContain(replacement);
    expect(serialized).not.toContain(localCandidate);
    expect(serialized).not.toMatch(/(?:data:image|base64,|Authorization)/u);
  });
});
