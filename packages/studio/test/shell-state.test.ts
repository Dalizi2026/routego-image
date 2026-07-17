import { describe, expect, it } from "vitest";

import {
  initialStudioAppState,
  navigationModeForWidth,
  studioAppReducer
} from "../src/app";
import { translate } from "../src/i18n";

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

  it("keeps critical shell messages coherent in both languages", () => {
    expect(translate("zh", "nav.workbench")).toBe("工作台");
    expect(translate("en", "nav.workbench")).toBe("Workbench");
    expect(translate("zh", "app.memoryOnly")).toBe("仅内存");
    expect(translate("en", "app.memoryOnly")).toBe("Memory only");
  });
});
