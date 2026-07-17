import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  REDACTED_BINARY_DATA,
  REDACTED_CIRCULAR_REFERENCE,
  REDACTED_IMAGE_DATA,
  REDACTED_VALUE,
  assertLoopbackBindAddress,
  authorizeLoopbackRequest,
  constantTimeSessionTokenEqual,
  createLoopbackCorsHeaders,
  createProtectedLegacyRoots,
  decideResultDownloadPolicy,
  describeProviderEndpoint,
  generateSessionToken,
  normalizeLoopbackOrigin,
  redactDiagnostic,
  redactFreeText,
  redactUrlForDiagnostics,
  resolveContainedPath
} from "../src/index";

describe("recursive diagnostics redaction", () => {
  it("redacts nested keys, free-text secrets, image payloads, URLs, and binary data without mutation", () => {
    const binary = new Uint8Array([1, 2, 3]);
    const source = {
      apiKey: "synthetic-api-key",
      nested: [
        {
          "x-routego-session": "synthetic-session",
          authorization: "Bearer synthetic-bearer",
          image: "data:image/png;base64,c3ludGhldGljLWltYWdl",
          endpoint: new URL("https://relay.example/path?token=synthetic#fragment"),
          binary
        }
      ],
      message:
        "Authorization: Bearer synthetic-message-token; endpoint=https://relay.example/result?token=synthetic#secret"
    };
    const originalImage = source.nested[0]?.image;
    const redacted = redactDiagnostic(source) as Record<string, unknown>;

    expect(redacted["apiKey"]).toBe(REDACTED_VALUE);
    expect(JSON.stringify(redacted)).not.toContain("synthetic-api-key");
    expect(JSON.stringify(redacted)).not.toContain("synthetic-session");
    expect(JSON.stringify(redacted)).not.toContain("synthetic-bearer");
    expect(JSON.stringify(redacted)).not.toContain("c3ludGhldGljLWltYWdl");
    expect(JSON.stringify(redacted)).toContain(REDACTED_IMAGE_DATA);
    expect(JSON.stringify(redacted)).toContain(REDACTED_BINARY_DATA);
    expect(JSON.stringify(redacted)).toContain("?[REDACTED]");
    expect(source.apiKey).toBe("synthetic-api-key");
    expect(source.nested[0]?.image).toBe(originalImage);
    expect(source.nested[0]?.binary).toBe(binary);
  });

  it("redacts bearer tokens and credential labels in UTF-8 free text", () => {
    const result = redactFreeText(
      "错误：Bearer synthetic.token；api_key=synthetic-key；password:synthetic-pass；中文保留 🚀"
    );
    expect(result).toContain("中文保留 🚀");
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain("synthetic.token");
    expect(result).not.toContain("synthetic-key");
    expect(result).not.toContain("synthetic-pass");
  });

  it("terminates circular references safely", () => {
    const source: Record<string, unknown> = { label: "root" };
    source["self"] = source;
    expect(redactDiagnostic(source)).toEqual({ label: "root", self: REDACTED_CIRCULAR_REFERENCE });
  });
});

describe("safe endpoint diagnostics", () => {
  it("validates provider URLs before returning a redacted descriptor", () => {
    const descriptor = describeProviderEndpoint(
      "https://relay.example/中文 path?token=synthetic",
      "exact-generation-endpoint"
    );
    expect(descriptor).toMatchObject({
      mode: "exact-generation-endpoint",
      origin: "https://relay.example",
      hasQuery: true
    });
    expect(descriptor.display).toContain("?[REDACTED]");
    expect(descriptor.display).not.toContain("synthetic");
    expect(() =>
      describeProviderEndpoint(
        "https://user:password@relay.example/v1/images/generations",
        "exact-generation-endpoint"
      )
    ).toThrow();
    expect(() =>
      describeProviderEndpoint("http://relay.example/v1/images/generations", "legacy-api-base")
    ).toThrow();
  });

  it("redacts URL query, fragment, and invalid input in arbitrary diagnostics", () => {
    expect(redactUrlForDiagnostics("https://relay.example/path?token=synthetic#secret")).toBe(
      "https://relay.example/path?[REDACTED]#[REDACTED]"
    );
    expect(redactUrlForDiagnostics("not a URL")).toBe("[INVALID_URL_REDACTED]");
  });
});

describe("provider result download authorization", () => {
  it("never forwards provider authorization to an arbitrary result URL by default", () => {
    expect(
      decideResultDownloadPolicy({
        resourceUrl: "https://cdn.example/image.png",
        providerEndpoint: "https://relay.example/v1/images/generations"
      })
    ).toEqual({
      allowed: true,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "authorization-disabled"
    });
  });

  it("allows credentials only for an explicit same-origin policy", () => {
    expect(
      decideResultDownloadPolicy({
        resourceUrl: "https://relay.example/results/image.png",
        providerEndpoint: "https://relay.example/v1/images/generations",
        explicitSameOriginAuthorization: true
      }).forwardAuthorization
    ).toBe(true);
    expect(
      decideResultDownloadPolicy({
        resourceUrl: "https://cdn.example/image.png",
        providerEndpoint: "https://relay.example/v1/images/generations",
        explicitSameOriginAuthorization: true
      }).forwardAuthorization
    ).toBe(false);
  });

  it("revalidates every redirect and strips credentials when the origin changes", () => {
    expect(
      decideResultDownloadPolicy({
        resourceUrl: "https://cdn.example/image.png",
        redirectFromUrl: "https://relay.example/results/image.png",
        providerEndpoint: "https://relay.example/v1/images/generations",
        explicitSameOriginAuthorization: true
      })
    ).toMatchObject({
      allowed: true,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "redirect-origin-changed"
    });
    expect(
      decideResultDownloadPolicy({
        resourceUrl: "https://relay.example/results/image-2.png",
        redirectFromUrl: "https://relay.example/results/image.png",
        providerEndpoint: "https://relay.example/v1/images/generations",
        explicitSameOriginAuthorization: true
      }).forwardAuthorization
    ).toBe(true);
  });

  it.each([
    "file:///tmp/image.png",
    "https://user:password@cdn.example/image.png",
    "http://cdn.example/image.png",
    "not a URL"
  ])("rejects unsafe download target %s", (resourceUrl) => {
    expect(
      decideResultDownloadPolicy({
        resourceUrl,
        providerEndpoint: "https://relay.example/v1/images/generations"
      }).allowed
    ).toBe(false);
  });
});

describe("loopback origin, session, and CORS policy", () => {
  it("allows only exact loopback bind addresses", () => {
    expect(assertLoopbackBindAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(assertLoopbackBindAddress("::1")).toBe("::1");
    for (const address of ["0.0.0.0", "::", "localhost", "192.168.1.20"]) {
      expect(() => assertLoopbackBindAddress(address)).toThrow(/bind only/u);
    }
  });

  it("creates non-empty random tokens and compares them without accepting empty values", () => {
    const first = generateSessionToken();
    const second = generateSessionToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(constantTimeSessionTokenEqual(first, first)).toBe(true);
    expect(constantTimeSessionTokenEqual(first, second)).toBe(false);
    expect(constantTimeSessionTokenEqual("", "")).toBe(false);
    expect(constantTimeSessionTokenEqual(first, "")).toBe(false);
  });

  it("authorizes only a matching origin and token without cookie authentication", () => {
    const token = generateSessionToken();
    const allowedOrigins = ["http://127.0.0.1:43119", "http://[::1]:43119"];
    expect(
      authorizeLoopbackRequest({
        origin: "http://127.0.0.1:43119",
        allowedOrigins,
        presentedToken: token,
        expectedToken: token
      })
    ).toEqual({ allowed: true, allowOrigin: "http://127.0.0.1:43119" });

    expect(
      authorizeLoopbackRequest({
        origin: "https://evil.example",
        allowedOrigins,
        presentedToken: token,
        expectedToken: token
      })
    ).toMatchObject({ allowed: false, code: "origin_rejected" });
    expect(
      authorizeLoopbackRequest({
        origin: "http://127.0.0.1:43119",
        allowedOrigins,
        presentedToken: "wrong-token",
        expectedToken: token
      })
    ).toMatchObject({ allowed: false, code: "session_invalid" });
    expect(
      authorizeLoopbackRequest({
        origin: "http://127.0.0.1:43119",
        allowedOrigins,
        presentedToken: token,
        expectedToken: token,
        cookieHeader: "session=synthetic"
      })
    ).toMatchObject({ allowed: false, code: "origin_rejected" });
  });

  it("emits exact-origin CORS headers without wildcard or credential cookies", () => {
    expect(normalizeLoopbackOrigin("http://127.0.0.1:43119")).toBe(
      "http://127.0.0.1:43119"
    );
    const headers = createLoopbackCorsHeaders("http://127.0.0.1:43119");
    expect(headers["access-control-allow-origin"]).toBe("http://127.0.0.1:43119");
    expect(headers["access-control-allow-origin"]).not.toBe("*");
    expect(headers).not.toHaveProperty("access-control-allow-credentials");
    expect(headers["access-control-allow-headers"]).toContain("x-routego-session");
  });
});

describe("Windows and POSIX path containment", () => {
  it("resolves contained Windows and POSIX paths while preserving spaces and UTF-8", () => {
    expect(
      resolveContainedPath({
        root: "C:\\Users\\测试 用户\\Pictures\\routego-image",
        candidate: "library\\2026\\07\\结果 图.png",
        platform: "win32",
        operation: "create"
      })
    ).toBe("C:\\Users\\测试 用户\\Pictures\\routego-image\\library\\2026\\07\\结果 图.png");
    expect(
      resolveContainedPath({
        root: "/Users/测试 用户/Pictures/routego-image",
        candidate: "library/2026/07/结果 图.png",
        platform: "posix",
        operation: "create"
      })
    ).toBe("/Users/测试 用户/Pictures/routego-image/library/2026/07/结果 图.png");
  });

  it.each([
    {
      root: "C:\\safe\\root",
      candidate: "..\\escape.png",
      platform: "win32" as const
    },
    {
      root: "C:\\safe\\root",
      candidate: "D:\\other\\escape.png",
      platform: "win32" as const
    },
    {
      root: "C:\\safe\\root",
      candidate: "\\\\server\\share\\escape.png",
      platform: "win32" as const
    },
    { root: "/safe/root", candidate: "../root-sibling/escape.png", platform: "posix" as const },
    { root: "/safe/root", candidate: "/safe/root-sibling/escape.png", platform: "posix" as const }
  ])("rejects traversal, drive, UNC, and sibling-prefix escapes %#", (fixture) => {
    expect(() => resolveContainedPath(fixture)).toThrow(/escapes/u);
  });

  it("rejects NUL paths and destructive overlap with protected legacy roots", () => {
    expect(() =>
      resolveContainedPath({ root: "/safe/root", candidate: "bad\0name.png", platform: "posix" })
    ).toThrow(/NUL/u);

    const protectedRoots = createProtectedLegacyRoots("C:\\Users\\Test User", "win32");
    expect(() =>
      resolveContainedPath({
        root: "C:\\Users\\Test User",
        candidate: "Pictures\\routego-image\\old.png",
        platform: "win32",
        operation: "delete",
        protectedRoots
      })
    ).toThrow(/protected legacy/u);
    expect(() =>
      resolveContainedPath({
        root: "C:\\Users\\Test User",
        candidate: ".codex\\routego-image-config.json",
        platform: "win32",
        operation: "overwrite",
        protectedRoots
      })
    ).toThrow(/protected legacy/u);
  });

  it("allows creation inside the new library without authorizing legacy deletion", () => {
    const protectedRoots = createProtectedLegacyRoots("/Users/test", "posix");
    expect(
      resolveContainedPath({
        root: "/Users/test/Pictures/routego-image",
        candidate: "library/2026/07/new.png",
        platform: "posix",
        operation: "create",
        protectedRoots
      })
    ).toBe("/Users/test/Pictures/routego-image/library/2026/07/new.png");
  });
});

describe("long-running service boundary guard", () => {
  async function collectSourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const child = path.join(directory, entry.name);
        return entry.isDirectory() ? collectSourceFiles(child) : [child];
      })
    );
    return files.flat().filter((file) => file.endsWith(".ts"));
  }

  it("does not expose stdout marker or forced process.exit result protocols", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../src");
    const contents = await Promise.all(
      (await collectSourceFiles(sourceRoot)).map((file) => readFile(file, "utf8"))
    );
    const source = contents.join("\n");
    expect(source).not.toMatch(/\bprocess\.exit\s*\(/u);
    expect(source).not.toContain("ROUTEGO_RESULT_JSON");
  });
});
