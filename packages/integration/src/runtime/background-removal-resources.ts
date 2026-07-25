import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BackgroundRemovalResource {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly version: string;
  readonly license: "Apache-2.0" | "MIT";
  readonly source: string;
}

interface BackgroundRemovalResourceManifest {
  readonly schemaVersion: 1;
  readonly offlineOnly: true;
  readonly resources: readonly BackgroundRemovalResource[];
}

export interface VerifiedBackgroundRemovalResources {
  readonly manifestPath: string;
  readonly resourceDirectory: string;
  readonly resources: ReadonlyMap<string, string>;
}

export interface VerifyBackgroundRemovalResourcesOptions {
  readonly manifestPath?: string;
  readonly resourceDirectory?: string;
}

export class OfflineBackgroundRemovalResourceError extends Error {
  override readonly name = "OfflineBackgroundRemovalResourceError";
}

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_RESOURCE_IDS = new Set([
  "u2netp-model",
  "onnxruntime-web-simd-threaded-jsep",
  "onnxruntime-web-simd-threaded"
]);

function failure(message: string): OfflineBackgroundRemovalResourceError {
  return new OfflineBackgroundRemovalResourceError(`Offline background-removal resource verification failed: ${message}`);
}

function isSafeFileName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function isResource(value: unknown): value is BackgroundRemovalResource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string" && isSafeFileName(candidate["path"]) &&
    Number.isSafeInteger(candidate["bytes"]) && (candidate["bytes"] as number) > 0 &&
    typeof candidate["sha256"] === "string" && /^[a-f0-9]{64}$/u.test(candidate["sha256"]) &&
    typeof candidate["version"] === "string" && candidate["version"].length > 0 &&
    (candidate["license"] === "Apache-2.0" || candidate["license"] === "MIT") &&
    typeof candidate["source"] === "string" && /^https:\/\//u.test(candidate["source"]);
}

function parseManifest(value: unknown): BackgroundRemovalResourceManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw failure("the manifest is not an object");
  const candidate = value as Record<string, unknown>;
  if (candidate["schemaVersion"] !== 1 || candidate["offlineOnly"] !== true || !Array.isArray(candidate["resources"]) ||
      candidate["resources"].length !== REQUIRED_RESOURCE_IDS.size || !candidate["resources"].every(isResource)) {
    throw failure("the manifest has an invalid shape");
  }
  const ids = new Set(candidate["resources"].map((resource) => resource.id));
  if (ids.size !== REQUIRED_RESOURCE_IDS.size || [...REQUIRED_RESOURCE_IDS].some((id) => !ids.has(id))) {
    throw failure("the manifest does not declare the required resources");
  }
  const names = new Set(candidate["resources"].map((resource) => resource.path));
  if (names.size !== candidate["resources"].length) throw failure("the manifest declares duplicate resource paths");
  return candidate as unknown as BackgroundRemovalResourceManifest;
}

async function defaultResourceDirectory(): Promise<string> {
  const candidates = [
    path.resolve(MODULE_DIRECTORY, "../../resources/background-removal"),
    path.resolve(MODULE_DIRECTORY, "../resources/background-removal")
  ];
  for (const candidate of candidates) {
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isSymbolicLink() && metadata.isDirectory()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw failure("the packaged resource directory is missing");
}

async function readRegularFile(file: string): Promise<Buffer> {
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw failure(`a required resource is missing: ${path.basename(file)}`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw failure(`a required resource is not a regular file: ${path.basename(file)}`);
  return readFile(file);
}

export async function verifyBackgroundRemovalResources(
  options: VerifyBackgroundRemovalResourcesOptions = {}
): Promise<VerifiedBackgroundRemovalResources> {
  const manifestPath = path.resolve(options.manifestPath ?? path.join(MODULE_DIRECTORY, "resource-manifest.json"));
  const manifestBytes = await readRegularFile(manifestPath);
  let manifest: BackgroundRemovalResourceManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch (error) {
    if (error instanceof OfflineBackgroundRemovalResourceError) throw error;
    throw failure("the manifest is not valid JSON");
  }

  const requestedDirectory = options.resourceDirectory ?? await defaultResourceDirectory();
  const directoryMetadata = await lstat(requestedDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw failure("the packaged resource directory is missing");
    throw error;
  });
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw failure("the resource directory is not a real directory");
  const resourceDirectory = await realpath(requestedDirectory);
  const resolved = new Map<string, string>();

  for (const resource of manifest.resources) {
    const resourcePath = path.resolve(resourceDirectory, resource.path);
    if (path.dirname(resourcePath) !== resourceDirectory) throw failure(`a resource path escapes its directory: ${resource.id}`);
    const bytes = await readRegularFile(resourcePath);
    if (bytes.byteLength !== resource.bytes || createHash("sha256").update(bytes).digest("hex") !== resource.sha256) {
      throw failure(`integrity mismatch: ${resource.id}`);
    }
    resolved.set(resource.id, resourcePath);
  }

  return { manifestPath, resourceDirectory, resources: resolved };
}
