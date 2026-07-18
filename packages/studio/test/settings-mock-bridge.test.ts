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
  it("keeps profile secrets and output paths write-only while separating refresh and probes", async () => {
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

    const probed = await gateway.invoke("probeCapabilities", {
      providerId: created.profile.id,
      model: refreshed.models[0]!,
      capability: "target-edit",
      transport: "openai-images",
      requestShape: "openai-images:edit-target",
      confirmBillableProbe: true
    });
    expect(probed).toMatchObject({
      status: "completed",
      mayHaveBilled: true,
      record: { state: "supported", capability: "target-edit" }
    });

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
    expect(await gateway.invoke("readSettings", {})).toEqual(updated);

    const removed = await gateway.invoke("removeProviderProfile", {
      profileId: "mock-provider"
    });
    expect(removed.removedProfileId).toBe("mock-provider");
    const finalSettings = await gateway.invoke("readSettings", {});
    expect(finalSettings.profiles.map((profile) => profile.id)).toEqual([
      created.profile.id
    ]);
    expect(JSON.stringify({ created, activated, cleared, refreshed, probed, updated, finalSettings }))
      .not.toMatch(/(?:synthetic-settings-one-shot-secret|\/synthetic\/routego-settings-output|data:image|base64|Authorization)/u);
  });
});
