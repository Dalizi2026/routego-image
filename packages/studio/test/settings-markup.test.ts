import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReadSettingsResult } from "@routego-image/contracts";

import type { StudioGateway } from "../src/api";
import { CapabilityProvider } from "../src/features/capabilities";
import { SettingsWorkspace } from "../src/features/settings";
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
  outputDirectory: { configured: true, display: "Pictures/routego-image" }
};

describe("secret-safe Settings workspace markup", () => {
  it("renders profile, refresh, probe, defaults, and redacted output controls without secrets", () => {
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLanguage: "en",
        children: createElement(CapabilityProvider, {
          providerId: settings.activeProviderId,
          model: settings.defaults.model,
          snapshots: [],
          children: createElement(SettingsWorkspace, {
            gateway: {} as StudioGateway,
            settings,
            onSettingsChange: () => undefined
          })
        })
      })
    );

    expect(markup).toContain("Relay configuration &amp; capability calibration");
    expect(markup).toContain("Refresh models (non-billable)");
    expect(markup).toContain("Potentially billable");
    expect(markup).toContain("Four-state capability evidence");
    expect(markup).toContain("Replace");
    expect(markup).not.toContain('type="password"');
    expect(markup).toContain("hidden query data");
    expect(markup).toContain("Pictures/routego-image");
    expect(markup).toContain("synthetic-present");
    expect(markup).not.toContain("synthetic-one-shot-secret");
    expect(markup).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64,|Authorization)/u);
  });

  it("keeps settings integration free of storage, logging, and remount shortcuts", () => {
    const sources = [
      "../src/features/settings/SettingsWorkspace.tsx",
      "../src/features/settings/state.ts",
      "../src/app/StudioApp.tsx",
      "../src/features/creation/CreationWorkbench.tsx"
    ]
      .map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/iu);
    expect(sources).not.toMatch(/console\.(?:log|info|warn|error|debug)/iu);
    expect(sources).not.toMatch(/dangerouslySetInnerHTML/iu);
    expect(sources).not.toMatch(/key=\{[^}]*defaults/iu);
    expect(sources).toContain('type="password"');
    expect(sources).toContain('autoComplete="off"');
  });
});
