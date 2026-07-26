import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  routegoStatusResultSchema,
  type LocalRoutegoService,
  type RoutegoService,
  type RoutegoOpenStudioResult
} from "@routego-image/contracts";

import {
  IntegrationLoopbackHttpHost,
  type IssuedStudioLaunch
} from "../src/runtime/http-host";
import {
  IntegrationHttpLifecycle,
  type ManagedIntegrationHttpHost,
  type RuntimeSignalSource
} from "../src/runtime/lifecycle";
import { StudioSessionManager } from "../src/runtime/sessions";
import { loadStudioStaticAssets, type StudioStaticAssetRegistry } from "../src/runtime/static";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }));
});

function statusResult() {
  return routegoStatusResultSchema.parse({
    schemaVersion: 1,
    configured: false,
    hasApiKey: false,
    models: [],
    capabilities: [],
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
    service: {
      status: "ready",
      version: "1.0.0",
      nodeVersion: "v20.19.0",
      uptimeSeconds: 1,
      mcpAvailable: true,
      httpAvailable: true,
      studioAvailable: true
    }
  });
}

function service(overrides: Record<string, unknown> = {}): LocalRoutegoService & RoutegoService {
  return new Proxy(overrides, {
    get(target, property) {
      if (typeof property === "string" && property in target) return target[property];
      return async () => {
        throw new Error(`Unused service method: ${String(property)}`);
      };
    }
  }) as unknown as LocalRoutegoService & RoutegoService;
}

async function staticFixture(): Promise<{
  readonly root: string;
  readonly registry: StudioStaticAssetRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "routego-static-"));
  temporaryRoots.add(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "app.ab12cd.js"), "globalThis.routegoLoaded=true;", "utf8");
  await writeFile(join(root, "assets", "app.ab12cd.css"), "body{color:#123}", "utf8");
  const registry = await loadStudioStaticAssets({
    rootDirectory: root,
    assets: {
      "/assets/app.ab12cd.js": "assets/app.ab12cd.js",
      "/assets/app.ab12cd.css": "assets/app.ab12cd.css"
    }
  });
  return { root, registry };
}

function sessionTokenFromBootstrap(html: string): string {
  const match = /"sessionToken":"([A-Za-z0-9_-]+)"/u.exec(html);
  if (match?.[1] === undefined) throw new Error("Bootstrap did not contain an in-memory session token");
  return match[1];
}

async function closeQuietly(host: IntegrationLoopbackHttpHost | undefined): Promise<void> {
  if (host === undefined) return;
  await host.close();
}

async function waitForStableCount(
  read: () => number,
  options: { readonly stableForMs?: number; readonly timeoutMs?: number } = {}
): Promise<number> {
  const stableForMs = options.stableForMs ?? 40;
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);
  let value = read();
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = read();
    if (current !== value) {
      value = current;
      lastChangeAt = Date.now();
    } else if (value > 0 && Date.now() - lastChangeAt >= stableForMs) {
      return value;
    }
  }
  throw new Error("The response producer did not reach a stable backpressure wait.");
}

describe("StudioSessionManager", () => {
  it("keeps the default launch and Studio windows usable for a long session", () => {
    let now = Date.parse("2026-07-19T00:00:00.000Z");
    const manager = new StudioSessionManager({ now: () => now });
    const issued = manager.issue();

    expect(Date.parse(issued.launchExpiresAt) - Date.parse(issued.createdAt)).toBe(30 * 60 * 1_000);
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.createdAt)).toBe(8 * 60 * 60 * 1_000);
    now += 10 * 60 * 1_000;
    expect(manager.authorizeLaunchToken(issued.launchToken)).toMatchObject({
      id: issued.id,
      sessionToken: issued.sessionToken
    });

    now += 20 * 60 * 1_000;
    expect(manager.authorizeLaunchToken(issued.launchToken)).toBeUndefined();
    now += 3 * 60 * 60 * 1_000;
    expect(manager.authorizeSessionToken(issued.sessionToken)).toMatchObject({ id: issued.id });
  });

  it("keeps bounded independent launch/API tokens and prunes exact expiry boundaries", () => {
    let now = Date.parse("2026-07-19T00:00:00.000Z");
    const manager = new StudioSessionManager({
      maximumActiveSessions: 2,
      sessionTtlMs: 1_000,
      launchTtlMs: 100,
      now: () => now
    });

    const first = manager.issue();
    const second = manager.issue();
    expect(first.sessionToken).not.toBe(first.launchToken);
    expect(first.sessionToken).not.toBe(second.sessionToken);
    expect(manager.size).toBe(2);
    expect(() => manager.issue()).toThrow(/active session limit/u);

    const activated = manager.authorizeLaunchToken(first.launchToken);
    expect(activated).toMatchObject({ id: first.id, sessionToken: first.sessionToken });
    expect(manager.authorizeLaunchToken(first.launchToken)).toEqual(activated);
    expect(manager.authorizeSessionToken(first.launchToken)).toBeUndefined();
    expect(manager.authorizeSessionToken(first.sessionToken)?.id).toBe(first.id);
    expect(manager.authorizeSessionToken("synthetic-mismatched-token-that-is-long-enough")).toBeUndefined();

    now += 100;
    expect(manager.authorizeLaunchToken(second.launchToken)).toBeUndefined();
    expect(manager.authorizeSessionToken(second.sessionToken)?.id).toBe(second.id);
    now += 900;
    expect(manager.authorizeSessionToken(first.sessionToken)).toBeUndefined();
    expect(manager.size).toBe(0);

    manager.close();
    expect(manager.closed).toBe(true);
    expect(() => manager.issue()).toThrow(/closed/u);
  });
});

describe("StudioStaticAssetRegistry", () => {
  it("serves only allowlisted immutable assets with exact MIME, size, ETag, and methods", async () => {
    const { registry } = await staticFixture();
    const response = registry.handle("GET", "/assets/app.ab12cd.js", "", {});
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "text/javascript; charset=utf-8",
      "content-length": "30",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff"
    });
    expect(response.headers?.["etag"]).toMatch(/^"sha256-[A-Za-z0-9_-]+"$/u);
    expect(Buffer.from(response.body as Uint8Array).toString("utf8")).toBe("globalThis.routegoLoaded=true;");

    const conditional = registry.handle("GET", "/assets/app.ab12cd.js", "", {
      "if-none-match": response.headers?.["etag"]
    });
    expect(conditional.status).toBe(304);
    expect(conditional.body).toBeUndefined();

    const head = registry.handle("HEAD", "/assets/app.ab12cd.css", "", {});
    expect(head.status).toBe(200);
    expect(head.headers?.["content-type"]).toBe("text/css; charset=utf-8");
    expect(head.body).toBeUndefined();

    for (const [path, search] of [
      ["/assets", ""],
      ["/assets/", ""],
      ["/assets/not-allowlisted.js", ""],
      ["/assets/%2e%2e/secret.js", ""],
      ["/assets/app.ab12cd.js", "?path=secret"]
    ] as const) {
      const denied = registry.handle("GET", path, search, {});
      expect(denied.status).toBe(404);
      expect(String(denied.body)).not.toMatch(/(?:routego-static|secret\.js|\\Users\\)/u);
    }
    expect(registry.handle("POST", "/assets/app.ab12cd.js", "", {}).status).toBe(405);
  });

  it("rejects an allowlisted symlink that escapes the static root", async () => {
    const root = await mkdtemp(join(tmpdir(), "routego-static-contained-"));
    const outside = await mkdtemp(join(tmpdir(), "routego-static-outside-"));
    temporaryRoots.add(root);
    temporaryRoots.add(outside);
    await mkdir(join(root, "assets"));
    await writeFile(join(outside, "outside.js"), "globalThis.outside=true;", "utf8");
    await symlink(outside, join(root, "assets", "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(loadStudioStaticAssets({
      rootDirectory: root,
      assets: { "/assets/outside.js": "assets/escape/outside.js" }
    })).rejects.toThrow(/escapes the static root/u);
  });
});

describe("IntegrationLoopbackHttpHost", () => {
  it("binds only IPv4/IPv6 loopback, bootstraps once, reuses sessions, and delegates protected JSON", async () => {
    const { registry } = await staticFixture();
    const status = vi.fn(async () => statusResult());
    const local = service({ status });
    expect(() => new IntegrationLoopbackHttpHost({
      service: local,
      localService: local,
      address: "0.0.0.0" as "127.0.0.1",
      staticAssets: registry,
      entryModuleRoute: "/assets/app.ab12cd.js"
    })).toThrow(/bind only/u);

    for (const address of ["127.0.0.1", "::1"] as const) {
      const host = new IntegrationLoopbackHttpHost({
        service: local,
        localService: local,
        address,
        staticAssets: registry,
        entryModuleRoute: "/assets/app.ab12cd.js",
        styleRoutes: ["/assets/app.ab12cd.css"]
      });
      try {
        const first = await host.openStudioSession();
        expect(first.result).toMatchObject({ reused: false, address });
        const launchUrl = new URL(first.result.url);
        expect(launchUrl.searchParams.get("token")).toBe(first.session.launchToken);
        expect(first.session.launchToken).not.toBe(first.session.sessionToken);

        const invalidQuery = await fetch(`${first.result.url}&unexpected=true`);
        expect(invalidQuery.status).toBe(403);
        const bootstrap = await fetch(first.result.url);
        expect(bootstrap.status).toBe(200);
        expect(bootstrap.headers.get("cache-control")).toContain("no-store");
        expect(bootstrap.headers.get("set-cookie")).toBeNull();
        const html = await bootstrap.text();
        expect(sessionTokenFromBootstrap(html)).toBe(first.session.sessionToken);
        expect(html.indexOf("history.replaceState")).toBeLessThan(html.indexOf('type="module"'));
        expect(html).not.toContain(first.session.launchToken);
        const openedAfterPreview = await fetch(first.result.url);
        expect(openedAfterPreview.status).toBe(200);
        expect(openedAfterPreview.headers.get("cache-control")).toContain("no-store");
        expect(sessionTokenFromBootstrap(await openedAfterPreview.text())).toBe(first.session.sessionToken);

        const staticResponse = await fetch(`${host.address!.origin}/assets/app.ab12cd.js`);
        expect(staticResponse.status).toBe(200);
        expect(staticResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(staticResponse.headers.get("access-control-allow-origin")).toBeNull();

        const api = `${host.address!.origin}/api/v1/status?refreshCapabilities=false`;
        const accepted = await fetch(api, {
          headers: {
            origin: host.address!.origin,
            "x-routego-session": first.session.sessionToken
          }
        });
        expect(accepted.status).toBe(200);
        expect(accepted.headers.get("access-control-allow-origin")).toBe(host.address!.origin);
        expect(accepted.headers.get("access-control-allow-credentials")).toBeNull();
        expect(await accepted.json()).toMatchObject({ configured: false });

        const browserAccepted = await fetch(api, {
          headers: {
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "x-routego-session": first.session.sessionToken
          }
        });
        expect(browserAccepted.status).toBe(200);
        expect(browserAccepted.headers.get("access-control-allow-origin")).toBe(host.address!.origin);
        expect(await browserAccepted.json()).toMatchObject({ configured: false });

        const preflight = await fetch(api, {
          method: "OPTIONS",
          headers: {
            origin: host.address!.origin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "x-routego-session"
          }
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(host.address!.origin);
        expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");

        for (const { label, headers } of [
          {
            label: "launch token",
            headers: { origin: host.address!.origin, "x-routego-session": first.session.launchToken }
          },
          {
            label: "foreign origin",
            headers: { origin: "https://example.invalid", "x-routego-session": first.session.sessionToken }
          },
          {
            label: "cookie",
            headers: { origin: host.address!.origin, "x-routego-session": first.session.sessionToken, cookie: "sid=forbidden" }
          },
          {
            label: "missing browser metadata",
            headers: { "x-routego-session": first.session.sessionToken }
          },
          {
            label: "cross-site metadata",
            headers: {
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "cors",
              "sec-fetch-dest": "empty",
              "x-routego-session": first.session.sessionToken
            }
          }
        ]) {
          const denied = await fetch(api, { headers });
          expect(denied.status, label).toBe(403);
          expect(await denied.text()).not.toContain(first.session.sessionToken);
        }

        const mismatchedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
          const request = httpRequest(api, {
            headers: {
              host: "evil.example",
              "sec-fetch-site": "same-origin",
              "sec-fetch-mode": "cors",
              "sec-fetch-dest": "empty",
              "x-routego-session": first.session.sessionToken
            }
          }, (response) => {
            response.resume();
            resolve(response.statusCode);
          });
          request.once("error", reject);
          request.end();
        });
        expect(mismatchedHostStatus).toBe(403);

        const second = await host.openStudioSession();
        expect(second.result.reused).toBe(true);
        expect(host.sessions.size).toBe(2);
        const firstStillValid = await fetch(api, {
          headers: { origin: host.address!.origin, "x-routego-session": first.session.sessionToken }
        });
        expect(firstStillValid.status).toBe(200);
      } finally {
        await closeQuietly(host);
      }
      expect(host.address).toBeUndefined();
      expect(host.sessions.size).toBe(0);
    }
    expect(status).toHaveBeenCalled();
  });

  it("rejects launch/session tokens at their exact independent expiry boundaries", async () => {
    const { registry } = await staticFixture();
    let now = Date.parse("2026-07-19T00:00:00.000Z");
    const sessions = new StudioSessionManager({
      sessionTtlMs: 1_000,
      launchTtlMs: 100,
      now: () => now
    });
    const local = service({ status: async () => statusResult() });
    const host = new IntegrationLoopbackHttpHost({
      service: local,
      localService: local,
      address: "127.0.0.1",
      staticAssets: registry,
      entryModuleRoute: "/assets/app.ab12cd.js",
      sessions
    });
    try {
      const launch = await host.openStudioSession();
      now += 100;
      expect((await fetch(launch.result.url)).status).toBe(403);
      const api = `${host.address!.origin}/api/v1/status`;
      expect((await fetch(api, {
        headers: { origin: host.address!.origin, "x-routego-session": launch.session.sessionToken }
      })).status).toBe(200);
      now += 900;
      expect((await fetch(api, {
        headers: { origin: host.address!.origin, "x-routego-session": launch.session.sessionToken }
      })).status).toBe(403);
      expect(sessions.size).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("returns the active protected-resource iterator when a client disconnects during backpressure", async () => {
    const { registry } = await staticFixture();
    const diagnostics: unknown[] = [];
    const descriptor = Object.freeze({ expiresAt: "2026-07-19T00:05:00.000Z" });
    const originalExpiry = descriptor.expiresAt;
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const totalChunks = 64;
    let nextCalls = 0;
    let returnCalls = 0;
    const closeLease = vi.fn();
    async function* protectedResourceBody(): AsyncGenerator<Uint8Array> {
      try {
        for (let index = 0; index < totalChunks; index += 1) {
          nextCalls += 1;
          yield chunk;
        }
      } finally {
        closeLease();
      }
    }
    const source = protectedResourceBody();
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => source.next(),
          return: async () => {
            returnCalls += 1;
            return source.return(undefined);
          }
        };
      }
    };
    const extensionHandler = vi.fn(async (request: { readonly url: URL }) => {
      if (request.url.pathname !== "/api/test/protected-large-resource") return undefined;
      return {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-length": String(chunk.byteLength * totalChunks),
          "content-type": "image/png",
          "x-content-type-options": "nosniff",
          "x-routego-expires-at": descriptor.expiresAt
        },
        body
      };
    });
    const local = service({ status: async () => statusResult() });
    const host = new IntegrationLoopbackHttpHost({
      service: local,
      localService: local,
      address: "127.0.0.1",
      staticAssets: registry,
      entryModuleRoute: "/assets/app.ab12cd.js",
      extensionHandler,
      logger(value) {
        diagnostics.push(value);
      }
    });
    let clientRequest: ReturnType<typeof httpRequest> | undefined;
    let clientResponse: IncomingMessage | undefined;
    try {
      const launch = await host.openStudioSession();
      expect((await fetch(launch.result.url)).status).toBe(200);
      const origin = host.address!.origin;
      clientResponse = await new Promise<IncomingMessage>((resolve, reject) => {
        clientRequest = httpRequest(`${origin}/api/test/protected-large-resource`, {
          headers: {
            origin,
            "x-routego-session": launch.session.sessionToken
          }
        }, (response) => {
          response.pause();
          resolve(response);
        });
        clientRequest.once("error", reject);
        clientRequest.end();
      });
      clientResponse.on("error", () => undefined);
      expect(clientResponse.statusCode).toBe(200);
      expect(clientResponse.headers["content-length"]).toBe(String(chunk.byteLength * totalChunks));
      expect(clientResponse.headers["x-routego-expires-at"]).toBe(originalExpiry);

      const stalledNextCalls = await waitForStableCount(() => nextCalls);
      expect(stalledNextCalls).toBeGreaterThan(0);
      expect(stalledNextCalls).toBeLessThan(totalChunks);
      clientResponse.destroy();
      await vi.waitFor(() => {
        expect(returnCalls).toBe(1);
        expect(closeLease).toHaveBeenCalledTimes(1);
      }, { interval: 5, timeout: 1_000 });
      const nextCallsAfterDisconnect = nextCalls;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(nextCalls).toBe(nextCallsAfterDisconnect);
      expect(extensionHandler).toHaveBeenCalledTimes(1);
      expect(descriptor.expiresAt).toBe(originalExpiry);
      const renderedDiagnostics = JSON.stringify(diagnostics);
      expect(renderedDiagnostics).not.toContain(launch.session.sessionToken);
      expect(renderedDiagnostics).not.toMatch(/(?:Authorization|base64|\\Users\\|90,90,90)/u);
    } finally {
      clientResponse?.destroy();
      clientRequest?.destroy();
      await host.close();
    }
  });
});

describe("IntegrationHttpLifecycle", () => {
  it("reuses a healthy listener, replaces it on request, and releases signals without forcing exit", async () => {
    const { registry } = await staticFixture();
    const local = service({ status: async () => statusResult() });
    const hosts: IntegrationLoopbackHttpHost[] = [];
    const lifecycle = new IntegrationHttpLifecycle({
      createHost(address) {
        const host = new IntegrationLoopbackHttpHost({
          service: local,
          localService: local,
          address,
          staticAssets: registry,
          entryModuleRoute: "/assets/app.ab12cd.js"
        });
        hosts.push(host);
        return host;
      }
    });
    const signals = new EventEmitter();
    lifecycle.installSignalHandlers(signals as RuntimeSignalSource);

    const first = await lifecycle.openStudio({ address: "127.0.0.1", reuseExisting: true });
    const firstBootstrap = await fetch(first.url);
    const firstToken = sessionTokenFromBootstrap(await firstBootstrap.text());
    const firstOrigin = new URL(first.url).origin;
    const second = await lifecycle.openStudio({ address: "127.0.0.1", reuseExisting: true });
    expect(second.reused).toBe(true);
    expect(new URL(second.url).origin).toBe(firstOrigin);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.sessions.size).toBe(2);
    expect(lifecycle.studioSession().expiresAt).toBe(second.expiresAt);
    expect((await fetch(`${firstOrigin}/api/v1/status`, {
      headers: { origin: firstOrigin, "x-routego-session": firstToken }
    })).status).toBe(200);

    const replacement = await lifecycle.openStudio({ address: "127.0.0.1", reuseExisting: false });
    expect(replacement.reused).toBe(false);
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.isHealthy).toBe(false);
    expect(hosts[0]?.sessions.closed).toBe(true);

    signals.emit("SIGTERM");
    await lifecycle.shutdown();
    expect(lifecycle.closed).toBe(true);
    expect(hosts[1]?.isHealthy).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    await expect(lifecycle.openStudio({ address: "127.0.0.1", reuseExisting: true })).rejects.toThrow(/shutting down/u);
  });

  it("recursively redacts shutdown diagnostics", async () => {
    const diagnostics: unknown[] = [];
    const sessions = new StudioSessionManager();
    const fakeHost: ManagedIntegrationHttpHost = {
      address: { address: "127.0.0.1" },
      isHealthy: true,
      sessions,
      async openStudioSession(): Promise<IssuedStudioLaunch> {
        const issued = sessions.issue();
        const result: RoutegoOpenStudioResult = {
          schemaVersion: 1,
          url: `http://127.0.0.1:43119/?token=${issued.launchToken}`,
          expiresAt: issued.expiresAt,
          reused: false,
          address: "127.0.0.1"
        };
        return { result, session: issued };
      },
      async close() {
        throw new Error(
          "Authorization: Bearer synthetic-secret sessionToken=synthetic-session path=C:\\Users\\secret\\image.png data:image/png;base64,AAAA"
        );
      }
    };
    const lifecycle = new IntegrationHttpLifecycle({
      createHost: () => fakeHost,
      logger(value) {
        diagnostics.push(value);
      }
    });
    await lifecycle.openStudio({ address: "127.0.0.1", reuseExisting: true });
    await expect(lifecycle.shutdown()).rejects.toThrow(/synthetic-secret/u);
    const rendered = JSON.stringify(diagnostics);
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("synthetic-session");
    expect(rendered).not.toContain("C:\\\\Users\\\\secret");
    expect(rendered).not.toContain("base64,AAAA");
    expect(rendered).toContain("[REDACTED]");
  });
});
