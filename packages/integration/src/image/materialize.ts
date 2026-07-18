import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, unlink } from "node:fs/promises";

import { imageArtifactSchema, type ImageArtifact } from "@routego-image/contracts";
import {
  MAX_PROVIDER_INPUT_BYTES,
  detectImageMetadata,
  type SupportedImageMimeType
} from "@routego-image/creation";

export const MAX_OPERATION_SOURCE_RENDITIONS = 17;
export const MAX_OPERATION_PARTIAL_OUTPUTS = 12;
export const MAX_OPERATION_FINAL_OUTPUTS = 4;
export const MAX_OPERATION_RENDITIONS = 33;
export const DEFAULT_MAX_MATERIALIZED_IMAGE_BYTES = MAX_PROVIDER_INPUT_BYTES;

export type ImageMaterializationErrorCode =
  | "artifact-invalid"
  | "artifact-duplicate"
  | "data-url-missing"
  | "data-url-invalid"
  | "image-too-large"
  | "mime-mismatch"
  | "metadata-missing"
  | "metadata-mismatch"
  | "hash-mismatch"
  | "rendition-limit"
  | "staging-conflict"
  | "staging-write-failed"
  | "transaction-closed"
  | "transaction-ownership";

export class ImageMaterializationError extends Error {
  readonly code: ImageMaterializationErrorCode;

  constructor(code: ImageMaterializationErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "ImageMaterializationError";
    this.code = code;
  }
}

export interface OperationRenditionCounts {
  readonly sourceCount: number;
  readonly partialOutputCount: number;
  readonly finalOutputCount: number;
}

export interface MaterializedImageOutput {
  readonly artifactId: string;
  readonly slot: number;
  readonly phase: "partial" | "final";
  readonly path: string;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly source: "provider-original" | "processed";
  readonly providerImageId?: string;
}

export interface MaterializationFailure {
  readonly artifactId: string;
  readonly slot: number;
  readonly phase: "partial" | "final";
  readonly code: ImageMaterializationErrorCode;
  readonly safeMessage: string;
}

export interface MaterializationBatchResult {
  readonly outputs: readonly MaterializedImageOutput[];
  readonly failures: readonly MaterializationFailure[];
  readonly receivedAnyOutput: boolean;
  readonly mayHaveBilled: boolean;
}

export interface MaterializeArtifactsOptions {
  readonly sourceCount?: number;
  readonly mayHaveBilled: boolean;
}

export interface OutputMaterializationTransactionOptions {
  readonly stagingRoot: string;
  readonly requestId: string;
  readonly maximumImageBytes?: number;
}

interface ValidatedImageBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/u;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function extensionFor(mimeType: SupportedImageMimeType): "png" | "jpg" | "webp" {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function assertOperationRenditionBound(counts: OperationRenditionCounts): void {
  if (
    !safeInteger(counts.sourceCount) ||
    !safeInteger(counts.partialOutputCount) ||
    !safeInteger(counts.finalOutputCount) ||
    counts.sourceCount > MAX_OPERATION_SOURCE_RENDITIONS ||
    counts.partialOutputCount > MAX_OPERATION_PARTIAL_OUTPUTS ||
    counts.finalOutputCount > MAX_OPERATION_FINAL_OUTPUTS ||
    counts.sourceCount + counts.partialOutputCount + counts.finalOutputCount >
      MAX_OPERATION_RENDITIONS
  ) {
    throw new ImageMaterializationError(
      "rendition-limit",
      "The operation exceeds the bounded source and output rendition capacity."
    );
  }
}

function strictBase64Decode(encoded: string, maximumBytes: number): Uint8Array {
  if (
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) {
    throw new ImageMaterializationError("data-url-invalid", "The image data URL is invalid.");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const approximateBytes = Math.floor((encoded.length * 3) / 4) - padding;
  if (approximateBytes > maximumBytes) {
    throw new ImageMaterializationError(
      "image-too-large",
      "The image data exceeds the materialization byte limit."
    );
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new ImageMaterializationError(
      bytes.byteLength > maximumBytes ? "image-too-large" : "data-url-invalid",
      bytes.byteLength > maximumBytes
        ? "The image data exceeds the materialization byte limit."
        : "The image data URL is invalid."
    );
  }
  if (bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) {
    throw new ImageMaterializationError("data-url-invalid", "The image data URL is invalid.");
  }
  return new Uint8Array(bytes);
}

function validateDetectedBytes(
  bytes: Uint8Array,
  expectedMimeType: SupportedImageMimeType,
  maximumBytes: number
): ValidatedImageBytes {
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new ImageMaterializationError(
      bytes.byteLength > maximumBytes ? "image-too-large" : "data-url-invalid",
      bytes.byteLength > maximumBytes
        ? "The image data exceeds the materialization byte limit."
        : "The image data is empty."
    );
  }
  let metadata;
  try {
    metadata = detectImageMetadata(bytes);
  } catch {
    throw new ImageMaterializationError(
      "artifact-invalid",
      "The image bytes do not contain a supported, complete image."
    );
  }
  if (metadata.mimeType !== expectedMimeType) {
    throw new ImageMaterializationError(
      "mime-mismatch",
      "The claimed image type does not match the detected bytes."
    );
  }
  return {
    bytes,
    mimeType: metadata.mimeType,
    byteLength: bytes.byteLength,
    width: metadata.width,
    height: metadata.height,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function decodeAndValidateArtifact(
  input: ImageArtifact,
  maximumBytes: number
): { readonly artifact: ImageArtifact; readonly validated: ValidatedImageBytes } {
  let artifact: ImageArtifact;
  try {
    artifact = imageArtifactSchema.parse(input);
  } catch {
    throw new ImageMaterializationError(
      "artifact-invalid",
      "The output artifact does not satisfy the shared image contract."
    );
  }
  const dataUrl = artifact.display?.dataUrl;
  if (dataUrl === undefined) {
    throw new ImageMaterializationError(
      "data-url-missing",
      "The output artifact does not contain materializable image data."
    );
  }
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new ImageMaterializationError("data-url-invalid", "The image data URL is invalid.");
  }
  const dataUrlMimeType = match[1] as SupportedImageMimeType;
  if (dataUrlMimeType !== artifact.mimeType) {
    throw new ImageMaterializationError(
      "mime-mismatch",
      "The image data URL type does not match the artifact claim."
    );
  }
  if (
    artifact.byteLength === undefined ||
    artifact.width === undefined ||
    artifact.height === undefined ||
    artifact.sha256 === undefined
  ) {
    throw new ImageMaterializationError(
      "metadata-missing",
      "The output artifact is missing required integrity metadata."
    );
  }
  const validated = validateDetectedBytes(
    strictBase64Decode(match[2], maximumBytes),
    dataUrlMimeType,
    maximumBytes
  );
  if (
    validated.byteLength !== artifact.byteLength ||
    validated.width !== artifact.width ||
    validated.height !== artifact.height
  ) {
    throw new ImageMaterializationError(
      "metadata-mismatch",
      "The image bytes do not match the artifact metadata."
    );
  }
  if (validated.sha256 !== artifact.sha256) {
    throw new ImageMaterializationError(
      "hash-mismatch",
      "The image bytes do not match the artifact checksum."
    );
  }
  return { artifact, validated };
}

async function writeExclusive(filePath: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      await unlink(filePath).catch(() => undefined);
    }
    if (isNodeError(error, "EEXIST")) {
      throw new ImageMaterializationError(
        "staging-conflict",
        "An exclusive output staging name already exists."
      );
    }
    throw new ImageMaterializationError(
      "staging-write-failed",
      "The image output could not be written to request-owned staging."
    );
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

function outputFromValidated(input: {
  readonly artifact: ImageArtifact;
  readonly path: string;
  readonly validated: ValidatedImageBytes;
  readonly source: MaterializedImageOutput["source"];
}): MaterializedImageOutput {
  return {
    artifactId: input.artifact.id,
    slot: input.artifact.slot,
    phase: input.artifact.phase,
    path: input.path,
    mimeType: input.validated.mimeType,
    byteLength: input.validated.byteLength,
    width: input.validated.width,
    height: input.validated.height,
    sha256: input.validated.sha256,
    createdAt: input.artifact.createdAt,
    source: input.source,
    ...(input.artifact.providerImageId === undefined
      ? {}
      : { providerImageId: input.artifact.providerImageId })
  };
}

export class OutputMaterializationTransaction {
  readonly #stagingRoot: string;
  readonly #directory: string;
  readonly #maximumImageBytes: number;
  readonly #selected = new Map<string, MaterializedImageOutput>();
  readonly #ownedOutputs = new Map<string, MaterializedImageOutput>();
  readonly #idleResolvers = new Set<() => void>();
  #activeOperations = 0;
  #closing = false;
  #closed = false;
  #cleanupPromise: Promise<void> | undefined;

  constructor(input: {
    readonly stagingRoot: string;
    readonly directory: string;
    readonly maximumImageBytes: number;
  }) {
    this.#stagingRoot = input.stagingRoot;
    this.#directory = input.directory;
    this.#maximumImageBytes = input.maximumImageBytes;
  }

  get directory(): string {
    return this.#directory;
  }

  get selectedOutputs(): readonly MaterializedImageOutput[] {
    return [...this.#selected.values()];
  }

  selectedOutput(artifactId: string): MaterializedImageOutput | undefined {
    return this.#selected.get(artifactId);
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing) {
      throw new ImageMaterializationError(
        "transaction-closed",
        "The output materialization transaction is closed."
      );
    }
  }

  async #runOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        for (const resolveIdle of this.#idleResolvers) resolveIdle();
        this.#idleResolvers.clear();
      }
    }
  }

  async #waitForIdle(): Promise<void> {
    if (this.#activeOperations === 0) return;
    await new Promise<void>((resolveIdle) => {
      this.#idleResolvers.add(resolveIdle);
    });
  }

  #filePath(
    artifact: Pick<ImageArtifact, "id" | "phase" | "slot">,
    mimeType: SupportedImageMimeType,
    source: MaterializedImageOutput["source"],
    suffix = ""
  ): string {
    const identity = createHash("sha256").update(artifact.id, "utf8").digest("hex").slice(0, 20);
    const extra = suffix.length === 0 ? "" : `-${suffix}`;
    return path.join(
      this.#directory,
      `${source}-${artifact.phase}-${artifact.slot}-${identity}${extra}.${extensionFor(mimeType)}`
    );
  }

  async #materializeArtifact(input: ImageArtifact): Promise<MaterializedImageOutput> {
    const { artifact, validated } = decodeAndValidateArtifact(input, this.#maximumImageBytes);
    if (this.#selected.has(artifact.id)) {
      throw new ImageMaterializationError(
        "artifact-duplicate",
        "The output artifact identity is duplicated within one request transaction."
      );
    }
    const filePath = this.#filePath(artifact, validated.mimeType, "provider-original");
    await writeExclusive(filePath, validated.bytes);
    const output = outputFromValidated({
      artifact,
      path: filePath,
      validated,
      source: "provider-original"
    });
    this.#ownedOutputs.set(filePath, output);
    this.#selected.set(output.artifactId, output);
    return output;
  }

  async materializeArtifact(input: ImageArtifact): Promise<MaterializedImageOutput> {
    return await this.#runOperation(async () => await this.#materializeArtifact(input));
  }

  async materializeArtifacts(
    artifacts: readonly ImageArtifact[],
    options: MaterializeArtifactsOptions
  ): Promise<MaterializationBatchResult> {
    return await this.#runOperation(async () => {
      assertOperationRenditionBound({
        sourceCount: options.sourceCount ?? 0,
        partialOutputCount: artifacts.filter((artifact) => artifact.phase === "partial").length,
        finalOutputCount: artifacts.filter((artifact) => artifact.phase === "final").length
      });
      const outputs: MaterializedImageOutput[] = [];
      const failures: MaterializationFailure[] = [];
      for (const artifact of artifacts) {
        try {
          outputs.push(await this.#materializeArtifact(artifact));
        } catch (error) {
          const materializationError =
            error instanceof ImageMaterializationError
              ? error
              : new ImageMaterializationError(
                  "staging-write-failed",
                  "The image output could not be materialized."
                );
          failures.push({
            artifactId: artifact.id,
            slot: artifact.slot,
            phase: artifact.phase,
            code: materializationError.code,
            safeMessage: materializationError.message
          });
        }
      }
      const receivedAnyOutput = this.#selected.size > 0;
      return {
        outputs,
        failures,
        receivedAnyOutput,
        mayHaveBilled: options.mayHaveBilled || receivedAnyOutput
      };
    });
  }

  async #readValidatedBytes(output: MaterializedImageOutput): Promise<Uint8Array> {
    const owned = this.#ownedOutputs.get(output.path);
    if (
      owned === undefined ||
      owned.artifactId !== output.artifactId ||
      owned.sha256 !== output.sha256
    ) {
      throw new ImageMaterializationError(
        "transaction-ownership",
        "The staged image does not belong to this request transaction."
      );
    }
    let metadata;
    let bytes: Uint8Array;
    try {
      metadata = await stat(output.path);
      bytes = await readFile(output.path);
    } catch {
      throw new ImageMaterializationError(
        "transaction-ownership",
        "The staged image is no longer available to this request transaction."
      );
    }
    if (!metadata.isFile() || metadata.size !== output.byteLength) {
      throw new ImageMaterializationError(
        "metadata-mismatch",
        "The staged image no longer matches its validated metadata."
      );
    }
    const validated = validateDetectedBytes(bytes, output.mimeType, this.#maximumImageBytes);
    if (
      validated.byteLength !== output.byteLength ||
      validated.width !== output.width ||
      validated.height !== output.height ||
      validated.sha256 !== output.sha256
    ) {
      throw new ImageMaterializationError(
        "hash-mismatch",
        "The staged image failed integrity validation."
      );
    }
    return validated.bytes;
  }

  async readValidatedBytes(output: MaterializedImageOutput): Promise<Uint8Array> {
    return await this.#runOperation(async () => await this.#readValidatedBytes(output));
  }

  async #stageReplacement(
    original: MaterializedImageOutput,
    bytes: Uint8Array,
    expectedMimeType: SupportedImageMimeType
  ): Promise<MaterializedImageOutput> {
    if (this.#selected.get(original.artifactId)?.path !== original.path) {
      throw new ImageMaterializationError(
        "transaction-ownership",
        "Only the currently selected output can be replaced."
      );
    }
    const validated = validateDetectedBytes(bytes, expectedMimeType, this.#maximumImageBytes);
    const artifact: ImageArtifact = {
      id: original.artifactId,
      slot: original.slot,
      phase: original.phase,
      mimeType: validated.mimeType,
      byteLength: validated.byteLength,
      width: validated.width,
      height: validated.height,
      sha256: validated.sha256,
      path: original.path,
      createdAt: original.createdAt,
      ...(original.providerImageId === undefined
        ? {}
        : { providerImageId: original.providerImageId })
    };
    const replacementPath = this.#filePath(
      artifact,
      validated.mimeType,
      "processed",
      validated.sha256.slice(0, 16)
    );
    await writeExclusive(replacementPath, validated.bytes);
    const replacement = outputFromValidated({
      artifact,
      path: replacementPath,
      validated,
      source: "processed"
    });
    this.#ownedOutputs.set(replacementPath, replacement);
    this.#selected.set(replacement.artifactId, replacement);
    return replacement;
  }

  async stageReplacement(
    original: MaterializedImageOutput,
    bytes: Uint8Array,
    expectedMimeType: SupportedImageMimeType
  ): Promise<MaterializedImageOutput> {
    return await this.#runOperation(
      async () => await this.#stageReplacement(original, bytes, expectedMimeType)
    );
  }

  async cleanup(): Promise<void> {
    if (this.#closed) return;
    if (this.#cleanupPromise !== undefined) return await this.#cleanupPromise;
    this.#closing = true;
    const cleanupPromise = (async () => {
      await this.#waitForIdle();
      const relative = path.relative(this.#stagingRoot, this.#directory);
      if (
        relative.length === 0 ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      ) {
        throw new ImageMaterializationError(
          "transaction-ownership",
          "The request staging directory is outside the approved staging root."
        );
      }
      await rm(this.#directory, { recursive: true, force: true });
    })();
    this.#cleanupPromise = cleanupPromise;
    try {
      await cleanupPromise;
    } catch (error) {
      this.#closing = false;
      this.#cleanupPromise = undefined;
      throw error;
    }
    this.#closed = true;
    this.#closing = false;
    this.#cleanupPromise = undefined;
    this.#selected.clear();
    this.#ownedOutputs.clear();
  }
}

export async function createOutputMaterializationTransaction(
  options: OutputMaterializationTransactionOptions
): Promise<OutputMaterializationTransaction> {
  const maximumImageBytes =
    options.maximumImageBytes ?? DEFAULT_MAX_MATERIALIZED_IMAGE_BYTES;
  if (
    !Number.isSafeInteger(maximumImageBytes) ||
    maximumImageBytes < 1 ||
    maximumImageBytes > DEFAULT_MAX_MATERIALIZED_IMAGE_BYTES
  ) {
    throw new ImageMaterializationError(
      "rendition-limit",
      "The output materialization byte limit is invalid."
    );
  }
  await mkdir(options.stagingRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = await realpath(options.stagingRoot);
  if (!(await stat(stagingRoot)).isDirectory()) {
    throw new ImageMaterializationError(
      "transaction-ownership",
      "The output staging root is not a directory."
    );
  }
  const requestFingerprint = createHash("sha256")
    .update(options.requestId, "utf8")
    .digest("hex")
    .slice(0, 20);
  const directory = await mkdtemp(path.join(stagingRoot, `request-${requestFingerprint}-`));
  return new OutputMaterializationTransaction({
    stagingRoot,
    directory,
    maximumImageBytes
  });
}
