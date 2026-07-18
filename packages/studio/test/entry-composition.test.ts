import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StudioGateway, StudioSession } from "../src/api";
import { StudioEntry } from "../src/main";

const session: StudioSession = {
  apply: (headers) => new Headers(headers)
};

describe("secure Studio entry composition", () => {
  it("does not construct or render the application gateway without a ready launch session", () => {
    const createGateway = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(StudioEntry, { bootstrap: { status: "missing" }, createGateway })
    );
    expect(createGateway).not.toHaveBeenCalled();
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("本地会话缺失或无效");
  });

  it("injects StudioApp only after the secure bootstrap provides its in-memory session", () => {
    const gateway = {} as StudioGateway;
    const createGateway = vi.fn(() => gateway);
    const markup = renderToStaticMarkup(
      createElement(StudioEntry, {
        bootstrap: { status: "ready", session },
        createGateway
      })
    );
    expect(createGateway).toHaveBeenCalledOnce();
    expect(createGateway).toHaveBeenCalledWith(session);
    expect(markup).toContain("正在显影工作区");
    expect(markup).not.toContain("本地会话缺失或无效");
  });
});
