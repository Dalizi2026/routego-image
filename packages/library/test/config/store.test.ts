import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LibraryError } from "../../src/errors";
import { writeJsonAtomic } from "../../src/fs/atomic-json";
import { writeTransactionJournal } from "../../src/fs/journal";
import {
  CONFIG_SECRET_TRANSACTION_KIND,
  LibrarySettingsStore
} from "../../src/config/store";

const roots: string[] = [];
const now = new Date("2026-01-01T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(
  options: ConstructorParameters<typeof LibrarySettingsStore>[0] = {}
): Promise<{ readonly root: string; readonly store: LibrarySettingsStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-config-"));
  roots.push(root);
  return {
    root,
    store: new LibrarySettingsStore({
      dataRoot: root,
      homeDirectory: path.join(root, "home"),
      now: () => now,
      idFactory: () => "provider-synthetic",
      ...options
    })
  };
}

const endpoints = {
  generation: {
    mode: "legacy-api-base" as const,
    value: "https://relay.example/custom-base?api-version=synthetic"
  }
};

async function upsert(
  store: LibrarySettingsStore,
  apiKey: { operation: "unchanged" } | { operation: "clear" } | { operation: "replace"; value: string },
  profileId?: string
) {
  return store.upsertProviderProfile({
    ...(profileId === undefined ? {} : { profileId }),
    name: "Synthetic relay",
    endpoints,
    defaultModel: "synthetic-image-model",
    apiKey,
    setActive: true
  });
}

describe("Library settings persistence", () => {
  it("initializes separate versioned documents without reading legacy configuration", async () => {
    const { store } = await createStore();
    const result = await store.readSettings({});
    expect(result).toMatchObject({
      schemaVersion: 1,
      profiles: [],
      outputDirectory: { configured: true }
    });
    expect(JSON.parse(await readFile(store.paths.config, "utf8"))).toMatchObject({
      schemaVersion: 1,
      profiles: []
    });
    expect(JSON.parse(await readFile(store.paths.credentials, "utf8"))).toEqual({
      schemaVersion: 1,
      revision: 0,
      apiKeys: {}
    });
  });

  it("keeps replace, unchanged, and clear API-key mutations out of settings results", async () => {
    const { store } = await createStore();
    const syntheticCredential = "synthetic-credential-value";
    const created = await upsert(store, { operation: "replace", value: syntheticCredential });
    expect(created.profile).toMatchObject({ hasApiKey: true, isActive: true });
    expect(JSON.stringify(created)).not.toContain(syntheticCredential);
    expect(await readFile(store.paths.config, "utf8")).not.toContain(syntheticCredential);
    expect(await readFile(store.paths.credentials, "utf8")).toContain(syntheticCredential);

    await upsert(store, { operation: "unchanged" }, created.profile.id);
    expect((await store.getRuntimeProviderProfile()).credential).toBe(syntheticCredential);
    await upsert(store, { operation: "clear" }, created.profile.id);
    expect((await store.readSettings({})).profiles[0]).toMatchObject({ hasApiKey: false });
    expect((await store.getRuntimeProviderProfile()).credential).toBeUndefined();
  });

  it("keeps credential documents owner-only on POSIX", async () => {
    if (process.platform === "win32") return;
    const { store } = await createStore();
    const created = await upsert(store, {
      operation: "replace",
      value: "synthetic-owner-only-credential"
    });
    await upsert(
      store,
      { operation: "replace", value: "synthetic-owner-only-replacement" },
      created.profile.id
    );
    expect((await stat(store.paths.credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(`${store.paths.credentials}.bak`)).mode & 0o777).toBe(0o600);
  });

  it("preserves exact endpoint ownership without deriving optional siblings", async () => {
    const { store } = await createStore();
    await upsert(store, { operation: "unchanged" });
    const runtime = await store.getRuntimeProviderProfile();
    expect(runtime.endpoints).toEqual(endpoints);
    expect(runtime.normalizedEndpoints.generationEndpoint).toBe(
      "https://relay.example/custom-base/v1/images/generations?api-version=synthetic"
    );
    expect(runtime.normalizedEndpoints).not.toHaveProperty("modelsEndpoint");
    expect(runtime.normalizedEndpoints).not.toHaveProperty("editsEndpoint");
    expect(runtime.normalizedEndpoints).not.toHaveProperty("responsesEndpoint");
    const visible = await store.readSettings({});
    expect(visible.profiles[0]?.endpoints.generation).toMatchObject({
      hasQuery: true,
      display: "https://relay.example/custom-base?[REDACTED]"
    });
  });

  it("unsets active selection when the active profile is removed", async () => {
    const { store } = await createStore();
    const created = await upsert(store, { operation: "unchanged" });
    await expect(store.setActiveProviderProfile({ profileId: "missing" })).rejects.toMatchObject({
      code: "not_found"
    });
    const removed = await store.removeProviderProfile({ profileId: created.profile.id });
    expect(removed.activeProviderId).toBeUndefined();
    expect(await store.readSettings({})).not.toHaveProperty("activeProviderId");
  });

  it("Task 4.4 atomically switches provider and model in one configuration revision", async () => {
    const { root, store } = await createStore();
    await store.upsertProviderProfile({
      profileId: "provider-a",
      name: "Synthetic A",
      endpoints,
      defaultModel: "shared-model",
      apiKey: { operation: "unchanged" },
      setActive: true
    });
    await store.upsertProviderProfile({
      profileId: "provider-b",
      name: "Synthetic B",
      endpoints,
      defaultModel: "fallback-model",
      apiKey: { operation: "unchanged" },
      setActive: false
    });
    await store.persistModelRefresh({
      schemaVersion: 1,
      providerId: "provider-b",
      status: "succeeded",
      billable: false,
      models: ["shared-model", "fallback-model"],
      refreshedAt: now.toISOString()
    });
    const settings = await store.readSettings({});
    await store.updateSettings({ defaults: { ...settings.defaults, model: "shared-model" } });
    const before = JSON.parse(await readFile(store.paths.config, "utf8")) as { revision: number };

    const preserved = await store.studioProviderSwitch({ profileId: "provider-b" });
    const afterPreserved = JSON.parse(await readFile(store.paths.config, "utf8")) as {
      revision: number;
      activeProviderId: string;
      defaults: { model: string };
    };
    expect(preserved).toMatchObject({
      status: "succeeded",
      activeProviderId: "provider-b",
      selectedModel: "shared-model",
      modelPreserved: true,
      appliesToFutureSubmissionsOnly: true
    });
    expect(afterPreserved).toMatchObject({
      revision: before.revision + 1,
      activeProviderId: "provider-b",
      defaults: { model: "shared-model" }
    });

    await store.updateSettings({ defaults: { ...(await store.readSettings({})).defaults, model: "a-only-model" } });
    const beforeFallback = JSON.parse(await readFile(store.paths.config, "utf8")) as { revision: number };
    const fallback = await store.studioProviderSwitch({ profileId: "provider-b" });
    const afterFallback = JSON.parse(await readFile(store.paths.config, "utf8")) as {
      revision: number;
      activeProviderId: string;
      defaults: { model: string };
    };
    expect(fallback).toMatchObject({ selectedModel: "fallback-model", modelPreserved: false });
    expect(afterFallback).toMatchObject({
      revision: beforeFallback.revision + 1,
      activeProviderId: "provider-b",
      defaults: { model: "fallback-model" }
    });
    expect(JSON.stringify(afterFallback)).not.toContain(root);
  });

  it("serializes concurrent profile writes without losing either profile", async () => {
    const { store } = await createStore();
    await Promise.all([
      store.upsertProviderProfile({
        profileId: "provider-a",
        name: "Synthetic A",
        endpoints,
        apiKey: { operation: "unchanged" },
        setActive: false
      }),
      store.upsertProviderProfile({
        profileId: "provider-b",
        name: "Synthetic B",
        endpoints,
        apiKey: { operation: "unchanged" },
        setActive: false
      })
    ]);
    expect((await store.readSettings({})).profiles.map((item) => item.id).sort()).toEqual([
      "provider-a",
      "provider-b"
    ]);
  });

  it("rolls back non-sensitive changes when credential permission enforcement fails", async () => {
    const { root, store } = await createStore();
    await store.readSettings({});
    const failing = new LibrarySettingsStore({
      dataRoot: root,
      homeDirectory: path.join(root, "home"),
      now: () => now,
      idFactory: () => "provider-failed",
      protectCredentialFile: async (candidate) => {
        if (candidate.endsWith(".tmp")) {
          throw new LibraryError("access_denied", "Synthetic permission failure.");
        }
      }
    });
    await expect(
      upsert(failing, { operation: "replace", value: "synthetic-failed-credential" })
    ).rejects.toMatchObject({ code: "file_write_failed" });
    expect((await store.readSettings({})).profiles).toEqual([]);
  });

  it("persists model and all four capability states while transient failures preserve prior state", async () => {
    const { store } = await createStore();
    const created = await upsert(store, { operation: "unchanged" });
    await store.persistModelRefresh({
      schemaVersion: 1,
      providerId: created.profile.id,
      status: "succeeded",
      billable: false,
      models: ["synthetic-image-model", "synthetic-image-model-v2"],
      refreshedAt: now.toISOString()
    });
    const scope = {
      providerId: created.profile.id,
      model: "synthetic-image-model",
      endpointFingerprint: "a".repeat(64),
      transport: "single-endpoint-json" as const,
      requestShape: "single-endpoint-json:image"
    };
    const states = [
      {
        state: "unknown" as const,
        evidence: [
          {
            source: "transient-failure" as const,
            observedAt: now.toISOString(),
            summary: "Synthetic timeout preserves state."
          }
        ]
      },
      {
        state: "supported" as const,
        evidence: [
          {
            source: "successful-request" as const,
            observedAt: now.toISOString(),
            summary: "Synthetic request succeeded."
          }
        ],
        verifiedAt: now.toISOString()
      },
      {
        state: "unsupported" as const,
        evidence: [
          {
            source: "protocol-rejection" as const,
            observedAt: now.toISOString(),
            summary: "Synthetic stable rejection."
          }
        ],
        verifiedAt: now.toISOString()
      },
      {
        state: "degraded" as const,
        evidence: [
          {
            source: "degraded-fallback" as const,
            observedAt: now.toISOString(),
            summary: "Synthetic weaker fallback."
          }
        ],
        verifiedAt: now.toISOString(),
        degradedReason: "Synthetic re-upload is required."
      }
    ];
    for (const [index, state] of states.entries()) {
      await store.persistCapabilityProbe({
        schemaVersion: 1,
        providerId: created.profile.id,
        model: scope.model,
        status: state.state === "unknown" ? "failed" : "completed",
        record: {
          capability: ["single-image-input", "multi-image-input", "mask-edit", "streaming"][index] as
            | "single-image-input"
            | "multi-image-input"
            | "mask-edit"
            | "streaming",
          scope,
          ...state
        },
        mayHaveBilled: false,
        ...(state.state === "unknown"
          ? {
              error: {
                code: "timeout",
                category: "timeout",
                stage: "submit",
                safeMessage: "Synthetic timeout.",
                retryDisposition: "never",
                partialArtifacts: [],
                receivedAnyOutput: false,
                mayHaveBilled: false
              }
            }
          : {})
      });
    }

    const supportedKey = {
      schemaVersion: 1 as const,
      providerId: created.profile.id,
      model: scope.model,
      status: "failed" as const,
      record: {
        capability: "multi-image-input" as const,
        scope,
        state: "unknown" as const,
        evidence: [
          {
            source: "transient-failure" as const,
            observedAt: "2026-01-02T00:00:00.000Z",
            summary: "Synthetic authentication failure remains transient."
          }
        ]
      },
      mayHaveBilled: false,
      error: {
        code: "auth_failed" as const,
        category: "authentication" as const,
        stage: "submit" as const,
        safeMessage: "Synthetic authentication failure.",
        retryDisposition: "user-confirmation" as const,
        partialArtifacts: [] as [],
        receivedAnyOutput: false as const,
        mayHaveBilled: false as const
      }
    };
    await store.persistCapabilityProbe(supportedKey);
    const runtime = await store.getRuntimeProviderProfile();
    expect(runtime.models).toEqual(["synthetic-image-model", "synthetic-image-model-v2"]);
    expect(new Set(runtime.capabilities.map((item) => item.state))).toEqual(
      new Set(["unknown", "supported", "unsupported", "degraded"])
    );
    expect(
      runtime.capabilities.find((item) => item.capability === "multi-image-input")
    ).toMatchObject({ state: "supported", evidence: expect.arrayContaining(supportedKey.record.evidence) });
  });

  it("persists defaults and all output-directory mutation modes without returning a full path", async () => {
    const { root, store } = await createStore();
    const custom = path.join(root, "selected", "outputs");
    const updated = await store.updateSettings({
      defaults: {
        model: "synthetic-image-model",
        size: "1024x1024",
        aspectRatio: "square",
        quality: "high",
        format: "webp",
        count: 2,
        partialImages: 1,
        transparentMode: "auto",
        moderation: "low",
        saveToLibrary: false
      },
      outputDirectory: { operation: "replace", path: custom, confirmLocalPath: true }
    });
    expect(updated.defaults).toMatchObject({ quality: "high", count: 2 });
    expect(updated.outputDirectory).toMatchObject({ configured: true, display: "…/selected/outputs" });
    expect(JSON.stringify(updated)).not.toContain(root);
    expect(await store.resolveOutputDirectory()).toBe(await import("node:fs/promises").then((fs) => fs.realpath(custom)));

    const unchanged = await store.updateSettings({
      outputDirectory: { operation: "unchanged" }
    });
    expect(unchanged.outputDirectory).toMatchObject({
      configured: true,
      display: "…/selected/outputs"
    });

    expect((await store.updateSettings({ outputDirectory: { operation: "clear" } })).outputDirectory)
      .toEqual({ configured: false });
    expect(await store.resolveOutputDirectory()).toBeUndefined();
    expect((await store.updateSettings({ outputDirectory: { operation: "default" } })).outputDirectory)
      .toMatchObject({ configured: true });
    expect(await store.resolveOutputDirectory()).toBe(
      path.join(root, "home", "Pictures", "routego-image", "library")
    );
  });

  it("leaves settings unchanged and redacts the submitted path when output validation fails", async () => {
    const { root, store } = await createStore();
    await store.readSettings({});
    const before = await readFile(store.paths.config, "utf8");
    const protectedPath = path.join(root, "home", "plugins", "routego-image");
    let failure: unknown;
    try {
      await store.updateSettings({
        outputDirectory: {
          operation: "replace",
          path: protectedPath,
          confirmLocalPath: true
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "path_unsafe" });
    expect(String(failure)).not.toContain(protectedPath);
    expect(await readFile(store.paths.config, "utf8")).toBe(before);
  });

  it("recovers an interrupted secret transaction by rolling the config document back", async () => {
    const { store } = await createStore();
    await store.readSettings({});
    const config = JSON.parse(await readFile(store.paths.config, "utf8")) as Record<string, unknown>;
    const credentials = JSON.parse(
      await readFile(store.paths.credentials, "utf8")
    ) as Record<string, unknown>;
    const nextConfig = {
      ...config,
      revision: (config["revision"] as number) + 1,
      defaults: { ...(config["defaults"] as object), quality: "high" }
    };
    await writeTransactionJournal(store.paths.root, {
      schemaVersion: 1,
      id: "config-recovery-test",
      kind: CONFIG_SECRET_TRANSACTION_KIND,
      state: "prepared",
      createdAt: now.toISOString(),
      createdPaths: [],
      deleteAfterCommitPaths: [],
      metadata: {
        configRevisionBefore: config["revision"] as number,
        configRevisionAfter: nextConfig.revision,
        credentialsRevisionBefore: credentials["revision"] as number,
        credentialsRevisionAfter: (credentials["revision"] as number) + 1
      }
    });
    await writeJsonAtomic(store.paths.config, nextConfig);
    expect((await store.readSettings({})).defaults.quality).toBe("auto");
  });

  it("rejects a future config even when an older valid backup exists", async () => {
    const { store } = await createStore();
    await store.readSettings({});
    await writeFile(`${store.paths.config}.bak`, await readFile(store.paths.config));
    await writeFile(store.paths.config, JSON.stringify({ schemaVersion: 2 }), "utf8");
    await expect(store.readSettings({})).rejects.toMatchObject({ code: "unsupported_version" });
    expect(JSON.parse(await readFile(store.paths.config, "utf8"))).toEqual({ schemaVersion: 2 });
  });

  it("recovers a corrupt primary from a valid backup while preserving the corrupt bytes", async () => {
    const { store } = await createStore();
    await store.readSettings({});
    await store.updateSettings({
      defaults: {
        size: "auto",
        aspectRatio: "auto",
        quality: "high",
        format: "png",
        count: 1,
        partialImages: 0,
        transparentMode: "off",
        moderation: "auto",
        saveToLibrary: true
      }
    });
    await writeFile(store.paths.config, "{synthetic-broken-json", "utf8");
    expect((await store.readSettings({})).defaults.quality).toBe("auto");
    const preserved = (await readdir(store.paths.root)).find((name) =>
      name.startsWith("config.json.corrupt-")
    );
    expect(preserved).toBeDefined();
    expect(await readFile(path.join(store.paths.root, preserved!), "utf8")).toBe(
      "{synthetic-broken-json"
    );
  });
});
