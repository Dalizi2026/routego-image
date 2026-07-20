import { describe, expect, it } from "vitest";

import {
  bootstrapStudioSession,
  STUDIO_SESSION_BOOTSTRAP_GLOBAL,
  STUDIO_SESSION_HEADER
} from "../src/api";

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

  it("consumes the server-injected session before the URL fallback", () => {
    const replaced: string[] = [];
    const result = bootstrapStudioSession({
      href: "http://127.0.0.1:4173/",
      injectedSession: {
        sessionToken: VALID_TOKEN,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      replaceUrl: (url) => replaced.push(url)
    });

    expect(replaced).toEqual(["/"]);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected injected session");
    expect(result.session.apply().get(STUDIO_SESSION_HEADER)).toBe(VALID_TOKEN);
    expect(STUDIO_SESSION_BOOTSTRAP_GLOBAL).toBe("__ROUTEGO_STUDIO_SESSION__");
  });

  it("rejects malformed or expired injected sessions without a URL-token fallback", () => {
    for (const injectedSession of [
      { sessionToken: "short", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { sessionToken: VALID_TOKEN, expiresAt: new Date(Date.now() - 1_000).toISOString() },
      { sessionToken: VALID_TOKEN, expiresAt: "not-a-date" }
    ]) {
      const result = bootstrapStudioSession({
        href: `http://127.0.0.1:4173/?token=${VALID_TOKEN}`,
        injectedSession,
        replaceUrl: () => undefined
      });
      expect(result.status).toBe("invalid");
    }
  });
});
