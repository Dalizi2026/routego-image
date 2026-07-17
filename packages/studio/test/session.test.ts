import { describe, expect, it } from "vitest";

import { bootstrapStudioSession, STUDIO_SESSION_HEADER } from "../src/api";

const VALID_TOKEN = "routego-studio-synthetic-session-token";

describe("in-memory Studio session bootstrap", () => {
  it("removes the launch token and attaches it only through the session header", () => {
    const replaced: string[] = [];
    const result = bootstrapStudioSession({
      href: `http://127.0.0.1:4173/library?token=${VALID_TOKEN}&lang=zh#detail`,
      replaceUrl: (url) => replaced.push(url)
    });

    expect(replaced).toEqual(["/library?lang=zh#detail"]);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected a ready session");
    }
    expect(result.session.apply().get(STUDIO_SESSION_HEADER)).toBe(VALID_TOKEN);
    expect(JSON.stringify(result.session)).not.toContain(VALID_TOKEN);
  });

  it("fails closed for missing, duplicated, or malformed launch values", () => {
    for (const href of [
      "http://127.0.0.1:4173/",
      `http://127.0.0.1:4173/?token=${VALID_TOKEN}&token=${VALID_TOKEN}`,
      "http://127.0.0.1:4173/?token=short"
    ]) {
      const replaced: string[] = [];
      const result = bootstrapStudioSession({ href, replaceUrl: (url) => replaced.push(url) });
      expect(result.status).not.toBe("ready");
      expect(replaced[0]).not.toContain("token=");
    }
  });
});
