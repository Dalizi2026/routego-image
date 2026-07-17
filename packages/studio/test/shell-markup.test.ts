import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppNavigation, AsyncStatePanel } from "../src/components";
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
    expect(markup.match(/<button/g)).toHaveLength(4);
    expect(markup).toContain("工作台");
    expect(markup).toContain("回收站");
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
});
