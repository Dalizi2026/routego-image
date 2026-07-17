import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StudioGateway } from "../src/api";
import { CapabilityProvider } from "../src/features/capabilities";
import { CreationWorkbench } from "../src/features/creation";
import { I18nProvider } from "../src/i18n";

const defaults = {
  model: "mock-image-model",
  size: "auto" as const,
  aspectRatio: "auto" as const,
  quality: "auto" as const,
  format: "png" as const,
  count: 1 as const,
  partialImages: 0 as const,
  transparentMode: "off" as const,
  moderation: "auto" as const,
  saveToLibrary: true
};

describe("capability-gated workbench markup", () => {
  it("renders the exact required message and four-state evidence ledger for unknown controls", () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          CapabilityProvider,
          { providerId: "mock-provider", model: "mock-image-model", snapshots: [] },
          createElement(CreationWorkbench, {
            gateway: {} as StudioGateway,
            defaults
          })
        )
      )
    );
    expect(markup).toContain("当前中转未确认支持");
    expect(markup).toContain("能力证据");
    expect(markup).toContain('data-state="unknown"');
    expect(markup).toContain("<span>mask-edit</span>");
    expect(markup).toContain('data-capability="native-transparency"');
    expect(markup).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64|Authorization)/u);
  });
});
