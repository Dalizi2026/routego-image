import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RoutegoHttpResponse } from "@routego-image/creation";

const DEFAULT_MAXIMUM_ASSET_BYTES = 16 * 1_024 * 1_024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

export interface StudioStaticAssetOptions {
  readonly rootDirectory: string;
  readonly assets: Readonly<Record<string, string>>;
  readonly maximumAssetBytes?: number;
}

interface LoadedStaticAsset {
  readonly route: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly etag: string;
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function safeRoute(route: string): boolean {
  if (!route.startsWith("/") || route === "/" || route.includes("\\") || route.includes("%")) {
    return false;
  }
  const segments = route.slice(1).split("/");
  return segments.every((segment) =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    /^[A-Za-z0-9._-]+$/u.test(segment)
  );
}

function safeRelativePath(file: string): boolean {
  if (file.length === 0 || isAbsolute(file) || file.includes("\\")) return false;
  const segments = file.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

function contained(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset !== "" && !offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset);
}

function staticError(status: number, code: string, safeMessage: string): RoutegoHttpResponse {
  return {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    },
    body: JSON.stringify({ error: { code, safeMessage } })
  };
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

export class StudioStaticAssetRegistry {
  readonly #assets: ReadonlyMap<string, LoadedStaticAsset>;

  private constructor(assets: ReadonlyMap<string, LoadedStaticAsset>) {
    this.#assets = assets;
  }

  static async load(options: StudioStaticAssetOptions): Promise<StudioStaticAssetRegistry> {
    const maximumAssetBytes = options.maximumAssetBytes ?? DEFAULT_MAXIMUM_ASSET_BYTES;
    if (!safeInteger(maximumAssetBytes)) {
      throw new Error("maximumAssetBytes must be a positive safe integer");
    }
    const rootDirectory = await realpath(resolve(options.rootDirectory));
    const rootStats = await stat(rootDirectory);
    if (!rootStats.isDirectory()) throw new Error("The Studio static root must be a directory.");

    const loaded = new Map<string, LoadedStaticAsset>();
    for (const [route, relativeFile] of Object.entries(options.assets)) {
      if (!safeRoute(route)) throw new Error("A Studio static route is invalid.");
      if (!safeRelativePath(relativeFile)) throw new Error("A Studio static asset path is invalid.");
      if (loaded.has(route)) throw new Error("A Studio static route is duplicated.");

      const extension = extname(relativeFile).toLowerCase();
      const mimeType = MIME_TYPES[extension];
      if (mimeType === undefined) throw new Error("A Studio static asset has an unsupported MIME type.");

      const requestedPath = join(rootDirectory, ...relativeFile.split("/"));
      let resolvedPath: string;
      try {
        resolvedPath = await realpath(requestedPath);
      } catch {
        throw new Error("An allowlisted Studio static asset is unavailable.");
      }
      if (!contained(rootDirectory, resolvedPath)) {
        throw new Error("An allowlisted Studio static asset escapes the static root.");
      }
      const fileStats = await stat(resolvedPath);
      if (!fileStats.isFile()) throw new Error("An allowlisted Studio static asset is not a file.");
      if (fileStats.size > maximumAssetBytes) {
        throw new Error("An allowlisted Studio static asset exceeds the configured size limit.");
      }
      const bytes = await readFile(resolvedPath);
      if (bytes.byteLength !== fileStats.size || bytes.byteLength > maximumAssetBytes) {
        throw new Error("An allowlisted Studio static asset changed while it was loaded.");
      }
      const etag = `"sha256-${createHash("sha256").update(bytes).digest("base64url")}"`;
      loaded.set(route, { route, mimeType, bytes, etag });
    }
    if (loaded.size === 0) throw new Error("At least one Studio static asset must be allowlisted.");
    return new StudioStaticAssetRegistry(loaded);
  }

  hasRoute(pathname: string): boolean {
    return this.#assets.has(pathname);
  }

  isStaticNamespace(pathname: string): boolean {
    return pathname === "/assets" || pathname.startsWith("/assets/");
  }

  handle(
    method: string,
    pathname: string,
    search: string,
    headers: Readonly<Record<string, string | undefined>>
  ): RoutegoHttpResponse {
    if (method !== "GET" && method !== "HEAD") {
      const response = staticError(
        405,
        "invalid_request",
        "The HTTP method is not allowed for static assets."
      );
      return {
        ...response,
        headers: { ...response.headers, allow: "GET, HEAD" }
      };
    }
    if (search !== "" || !safeRoute(pathname)) {
      return staticError(404, "not_found", "The requested static asset was not found.");
    }
    const asset = this.#assets.get(pathname);
    if (asset === undefined) {
      return staticError(404, "not_found", "The requested static asset was not found.");
    }
    const responseHeaders: Record<string, string> = {
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(asset.bytes.byteLength),
      "content-type": asset.mimeType,
      etag: asset.etag,
      "x-content-type-options": "nosniff"
    };
    if (header(headers, "if-none-match") === asset.etag) {
      return { status: 304, headers: responseHeaders };
    }
    return {
      status: 200,
      headers: responseHeaders,
      ...(method === "HEAD" ? {} : { body: asset.bytes })
    };
  }
}

export async function loadStudioStaticAssets(
  options: StudioStaticAssetOptions
): Promise<StudioStaticAssetRegistry> {
  return StudioStaticAssetRegistry.load(options);
}
