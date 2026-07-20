import { describe, expect, it } from "vitest";

import type { ReadSettingsResult } from "@routego-image/contracts";

import {
  firstRunReadiness,
  initialStudioAppState,
  initialStudioRouteForSettings,
  navigationModeForWidth,
  studioAppReducer
} from "../src/app";
import { translate } from "../src/i18n";

function settings(
  profile: { readonly active: boolean; readonly hasApiKey: boolean; readonly model?: string } | undefined
): ReadSettingsResult {
  return {
    schemaVersion: 1,
    ...(profile?.active === true ? { activeProviderId: "provider-1" } : {}),
    profiles:
      profile === undefined
        ? []
        : [
            {
              id: "provider-1",
              name: "Synthetic provider",
              endpoints: {
                generation: {
                  mode: "exact-generation-endpoint",
                  origin: "https://relay.invalid",
                  pathname: "/generate",
                  display: "relay.invalid/generate",
                  hasQuery: false
                }
              },
              ...(profile.model === undefined ? {} : { defaultModel: profile.model }),
              models: [],
              hasApiKey: profile.hasApiKey,
              isActive: profile.active,
              createdAt: "2026-07-20T00:00:00.000Z",
              updatedAt: "2026-07-20T00:00:00.000Z"
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
}

describe("Studio shell state and responsive helpers", () => {
  it("preserves route state independently from notifications", () => {
    const library = studioAppReducer(initialStudioAppState, {
      type: "navigate",
      route: "library"
    });
    const notified = studioAppReducer(library, {
      type: "replace-notices",
      notices: [
        {
          id: "ready",
          tone: "success",
          title: "notice.readyTitle",
          body: "notice.readyBody",
          dismissible: true
        }
      ]
    });
    expect(notified.route).toBe("library");
    expect(
      studioAppReducer(notified, { type: "dismiss-notice", id: "ready" })
    ).toMatchObject({ route: "library", notices: [] });
  });

  it("uses bottom navigation only below the mobile breakpoint", () => {
    expect(navigationModeForWidth(320)).toBe("bottom");
    expect(navigationModeForWidth(719)).toBe("bottom");
    expect(navigationModeForWidth(720)).toBe("rail");
    expect(navigationModeForWidth(1440)).toBe("rail");
  });

  it("routes incomplete redacted settings to first-run setup", () => {
    expect(firstRunReadiness(settings(undefined))).toEqual({
      hasActiveProfile: false,
      hasApiKey: false,
      hasModel: false,
      complete: false
    });
    expect(initialStudioRouteForSettings(settings(undefined))).toBe("settings");
    expect(initialStudioRouteForSettings(settings({ active: true, hasApiKey: false, model: "image-1" }))).toBe("settings");
    expect(initialStudioRouteForSettings(settings({ active: true, hasApiKey: true }))).toBe("settings");
  });

  it("keeps configured settings on the workbench", () => {
    const configured = settings({ active: true, hasApiKey: true, model: "image-1" });
    expect(firstRunReadiness(configured)).toMatchObject({ complete: true });
    expect(initialStudioRouteForSettings(configured)).toBe("workbench");
  });

  it("keeps critical shell messages coherent in both languages", () => {
    expect(translate("zh", "nav.workbench")).toBe("工作台");
    expect(translate("en", "nav.workbench")).toBe("Workbench");
    expect(translate("zh", "app.memoryOnly")).toBe("仅内存");
    expect(translate("en", "app.memoryOnly")).toBe("Memory only");
  });
});
