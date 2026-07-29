import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReadSettingsResult } from "@routego-image/contracts";

import type { StudioGateway } from "../src/api";
import { GenerationDefaultsPanel, SettingsWorkspace } from "../src/features/settings";
import { I18nProvider } from "../src/i18n";

const settings: ReadSettingsResult = {
  schemaVersion: 1,
  activeProviderId: "provider-settings",
  profiles: [
    {
      id: "provider-settings",
      name: "Synthetic settings relay",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          origin: "https://relay.example.invalid",
          pathname: "/v1/images/generations",
          hasQuery: true,
          display: "https://relay.example.invalid/v1/images/generations?[REDACTED]"
        },
        edits: {
          mode: "exact-generation-endpoint",
          origin: "https://relay.example.invalid",
          pathname: "/v1/images/edits",
          hasQuery: false,
          display: "https://relay.example.invalid/v1/images/edits"
        }
      },
      defaultModel: "synthetic-image-model",
      models: ["synthetic-image-model"],
      hasApiKey: true,
      apiKeyPreview: "synthetic-present",
      isActive: true,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z"
    }
  ],
  defaults: {
    model: "synthetic-image-model",
    size: "2048x2048",
    aspectRatio: "1:1",
    quality: "auto",
    format: "png",
    count: 1,
    partialImages: 0,
    transparentMode: "off",
    moderation: "auto",
    saveToLibrary: true
  },
  outputDirectory: { configured: true, display: "Pictures/routego-image" }
};

const incompleteSettings: ReadSettingsResult = {
  schemaVersion: 1,
  activeProviderId: "provider-incomplete",
  profiles: [
    {
      id: "provider-incomplete",
      name: "Incomplete relay",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          origin: "https://relay.example.invalid",
          pathname: "/",
          hasQuery: false,
          display: "https://relay.example.invalid/"
        }
      },
      models: [],
      hasApiKey: false,
      isActive: true,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z"
    }
  ],
  defaults: {
    size: "auto",
    aspectRatio: "auto",
    quality: "auto",
    format: "png",
    count: 1,
    partialImages: 0,
    transparentMode: "off",
    moderation: "auto",
    saveToLibrary: true
  },
  outputDirectory: { configured: false }
};

describe("secret-safe Settings workspace markup", () => {
  it("renders a saved response wait control with a five-minute default and upstream-timeout note", () => {
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLanguage: "en",
        children: createElement(GenerationDefaultsPanel, {
          gateway: {} as StudioGateway,
          settings,
          onSettingsChange: () => undefined
        })
      })
    );

    expect(markup).toContain("Response wait limit");
    expect(markup).toContain('value="300000"');
    expect(markup).toContain("cannot extend an earlier timeout imposed by the provider itself");
    expect(markup).toContain("Verify current defaults");
    expect(markup).toContain("Start verification (may be billable)");
    expect(markup).toContain("Custom size and aspect ratio");
    expect(markup).toContain("Custom dimensions");
    expect(markup).toContain("21:9");
  });

  it("renders first run as a concise provider editor", () => {
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLanguage: "en",
        children: createElement(SettingsWorkspace, {
          gateway: {} as StudioGateway,
          settings: incompleteSettings,
          onSettingsChange: () => undefined,
          firstRunSession: true
        })
      })
    );

    expect(markup).toContain("Provider management");
    expect(markup).toContain("API endpoint");
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Get models");
    expect(markup).toContain("https://relay.example.invalid/");
    expect(markup).toContain("Name");
    expect(markup).not.toContain("Generation endpoint mode");
    expect(markup).not.toContain("Refresh models (non-billable)");
    expect(markup).not.toContain("Verify current defaults");
    expect(markup).not.toContain("Four-state capability evidence");
  });

  it("keeps repeat configuration to provider choice, summary, and an explicit edit action", () => {
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLanguage: "en",
        children: createElement(SettingsWorkspace, {
          gateway: {} as StudioGateway,
          settings,
          onSettingsChange: () => undefined
        })
      })
    );

    expect(markup).toContain("Provider management");
    expect(markup).toContain("Current provider");
    expect(markup).toContain("Edit");
    expect(markup).toContain("API key configured");
    expect(markup).toContain("Current model");
    expect(markup).not.toContain("Advanced settings");
    expect(markup).toContain("New provider");
    expect(markup).not.toContain("Edits endpoint (optional)");
    expect(markup).not.toContain("https://relay.example.invalid/v1/images/edits");
    expect(markup).not.toContain("Refresh models (non-billable)");
    expect(markup).not.toContain("Start verification (may be billable)");
    expect(markup).not.toContain("Four-state capability evidence");
    expect(markup).not.toContain("Pictures/routego-image");
    expect(markup).not.toContain("synthetic-present");
    expect(markup).not.toContain("synthetic-one-shot-secret");
    expect(markup).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64,|Authorization)/u);
  });

  it("keeps settings integration free of storage, logging, and remount shortcuts", () => {
    const workspaceSource = readFileSync(
      new URL("../src/features/settings/SettingsWorkspace.tsx", import.meta.url),
      "utf8"
    );
    const sources = [
      "../src/features/settings/state.ts",
      "../src/app/StudioApp.tsx",
      "../src/features/creation/CreationWorkbench.tsx"
    ]
      .map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"))
      .concat(workspaceSource)
      .join("\n");

    expect(sources).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/iu);
    expect(sources).not.toMatch(/console\.(?:log|info|warn|error|debug)/iu);
    expect(sources).not.toMatch(/dangerouslySetInnerHTML/iu);
    expect(sources).not.toMatch(/key=\{[^}]*defaults/iu);
    expect(sources).toContain('type="password"');
    expect(sources).toContain('autoComplete="new-password"');

    const apiKeyClear = workspaceSource.indexOf(
      "setDraft((current) => clearApiKeyDraft(current));"
    );
    const profileDispatch = workspaceSource.indexOf(
      'gateway.invoke("upsertProviderProfile", input)'
    );
    expect(apiKeyClear).toBeGreaterThan(-1);
    expect(profileDispatch).toBeGreaterThan(apiKeyClear);
    expect(workspaceSource).not.toContain("CapabilityProbePanel");
    expect(workspaceSource).not.toContain("buildOutputDirectorySettingsInput");
  });
});
