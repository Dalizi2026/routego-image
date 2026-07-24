import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppNavigation, AsyncStatePanel } from "../src/components";
import { HeaderProviderSelector } from "../src/app/StudioApp";
import { I18nProvider } from "../src/i18n";

describe("accessible Studio shell markup", () => {
  it("renders a labelled primary navigation with one current page", () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(AppNavigation, { route: "library", onNavigate: () => undefined })
      )
    );
    expect(markup).toContain("<nav");
    expect(markup).toContain('aria-label="Studio 主导航"');
    expect(markup).toContain('aria-current="page"');
    expect(markup.match(/<button/g)).toHaveLength(3);
    expect(markup).toContain("工作台");
    expect(markup).toContain("图库");
    expect(markup).not.toContain("回收站");
  });

  it("uses assertive failure semantics and polite loading semantics", () => {
    const failure = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(AsyncStatePanel, {
          state: "failure",
          title: "Failed",
          children: "Safe error"
        })
      )
    );
    const loading = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(AsyncStatePanel, {
          state: "loading",
          title: "Loading",
          children: "Please wait"
        })
      )
    );
    expect(failure).toContain('role="alert"');
    expect(failure).toContain('aria-live="assertive"');
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-busy="true"');
  });

  it("renders an accessible Header provider selector with snapshot messaging", () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(HeaderProviderSelector, {
          gateway: {} as never,
          settings: {
            schemaVersion: 1,
            activeProviderId: "provider-a",
            profiles: [
              {
                id: "provider-a",
                name: "Synthetic provider A",
                endpoints: {
                  generation: {
                    mode: "exact-generation-endpoint",
                    origin: "https://relay.invalid",
                    pathname: "/generate",
                    display: "relay.invalid/generate",
                    hasQuery: false
                  }
                },
                defaultModel: "image-1",
                models: ["image-1"],
                hasApiKey: true,
                isActive: true,
                createdAt: "2026-07-20T00:00:00.000Z",
                updatedAt: "2026-07-20T00:00:00.000Z"
              }
            ],
            defaults: {
              model: "image-1",
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
          },
          state: { status: "idle" },
          onSettingsChange: () => undefined,
          onStateChange: () => undefined
        })
      )
    );
    expect(markup).toContain('id="studio-provider-select"');
    expect(markup).toContain('data-provider-switch-state="idle"');
    expect(markup).toContain("已提交的请求保留提交时的服务商和模型");
    expect(markup).toContain("Synthetic provider A / image-1");
    expect(markup).toContain("disabled");
  });
});
