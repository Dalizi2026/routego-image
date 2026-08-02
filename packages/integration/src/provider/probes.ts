import {
  capabilityProbeInputSchema,
  capabilityProbeResultSchema,
  type CapabilityEvidence,
  type CapabilityProbeInput,
  type CapabilityProbeResult,
  type ProviderCapability,
  type ProviderCapabilityRecord,
  type ProviderTransport,
  type RoutegoServiceError
} from "@routego-image/contracts";
import {
  createUnknownCapabilityRecord,
  evaluateCapabilityProbe,
  fingerprintProviderEndpoint,
  PROVIDER_REQUEST_SHAPES,
  transitionCapability
} from "@routego-image/foundation";
import { downloadProviderImage, ProviderDownloadException } from "@routego-image/creation";
import type { RuntimeProviderProfile } from "@routego-image/library";
import { PNG } from "pngjs";

import { createDeterministicSyntheticPngInputs } from "../image/png";
import {
  ProviderIntegrationError,
  boundedRedactedDiagnostic,
  createProviderServiceError,
  redactProviderText,
  toProviderServiceError,
  type ProviderProfileReader
} from "./context";
import { readBoundedResponseBytes } from "./models";

export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 120_000;
export const MAX_CAPABILITY_PROBE_ERROR_BYTES = 32 * 1024;
export const MAX_CAPABILITY_PROBE_SUCCESS_BYTES = 8 * 1024 * 1024;
// Capability probes inspect 8-bit, non-interlaced proof images rather than materializing unrestricted
// provider output. This decoder profile keeps pngjs on its bounded four-byte RGBA path, capped at 16 MiB.
export const MAX_CAPABILITY_PROBE_PNG_DIMENSION = 4_096;
export const MAX_CAPABILITY_PROBE_PNG_PIXELS = 4 * 1_024 * 1_024;
export const MAX_CAPABILITY_PROBE_PNG_RGBA_BYTES = 16 * 1_024 * 1_024;

export interface CapabilityProbeOwner extends ProviderProfileReader {
  persistCapabilityProbe(result: CapabilityProbeResult): Promise<void>;
}

export type CapabilityProbeOutcome =
  | { readonly outcome: "supported" }
  | { readonly outcome: "unsupported"; readonly providerCode?: string }
  | { readonly outcome: "degraded"; readonly degradedReason: string }
  | {
      readonly outcome: "transient";
      readonly error: RoutegoServiceError;
      readonly providerCode?: string;
    };

export interface CapabilityProbeRequestDescriptor {
  readonly endpoint: string;
  readonly request: RequestInit;
}

export interface ProbeProviderCapabilityOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

type ProbeResponseProof =
  | "images-output"
  | "images-quality-control"
  | "images-two-outputs"
  | "images-custom-size"
  | "images-jpeg-output"
  | "images-alpha-output"
  | "responses-completed-output";

export interface CapabilityProbePair {
  readonly transport: ProviderTransport;
  readonly requestShape: string;
  readonly capability: ProviderCapability;
}

interface CapabilityProbeDefinition extends CapabilityProbePair {
  readonly responseProof: ProbeResponseProof;
}

const CAPABILITY_PROBE_DEFINITIONS: readonly CapabilityProbeDefinition[] = [
  ...[
    PROVIDER_REQUEST_SHAPES.singleEndpointText,
    PROVIDER_REQUEST_SHAPES.imagesGenerationsJson
  ].flatMap((requestShape): CapabilityProbeDefinition[] => {
    const transport = requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointText
      ? "single-endpoint-json" as const
      : "openai-images" as const;
    return [
      { transport, requestShape, capability: "text-generation", responseProof: "images-output" },
      { transport, requestShape, capability: "quality-control", responseProof: "images-quality-control" },
      { transport, requestShape, capability: "native-variants", responseProof: "images-two-outputs" },
      { transport, requestShape, capability: "custom-size", responseProof: "images-custom-size" },
      { transport, requestShape, capability: "output-format", responseProof: "images-jpeg-output" },
      { transport, requestShape, capability: "native-transparency", responseProof: "images-alpha-output" }
    ];
  }),
  {
    transport: "single-endpoint-json",
    requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
    capability: "single-image-input",
    responseProof: "images-output"
  },
  {
    transport: "single-endpoint-json",
    requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
    capability: "native-transparency",
    responseProof: "images-alpha-output"
  },
  {
    transport: "single-endpoint-json",
    requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
    capability: "data-url-input",
    responseProof: "images-output"
  },
  {
    transport: "single-endpoint-json",
    requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImages,
    capability: "multi-image-input",
    responseProof: "images-output"
  },
  {
    transport: "single-endpoint-json",
    requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImages,
    capability: "data-url-input",
    responseProof: "images-output"
  },
  ...[
    "text-generation",
    "single-image-input",
    "multi-image-input",
    "data-url-input"
  ].map((capability): CapabilityProbeDefinition => ({
    transport: "openai-responses",
    requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration,
    capability: capability as ProviderCapability,
    responseProof: "responses-completed-output"
  }))
];

export const CAPABILITY_PROBE_PAIRS: readonly CapabilityProbePair[] =
  CAPABILITY_PROBE_DEFINITIONS.map(({ responseProof: _responseProof, ...pair }) => pair);

function safeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_input",
        stage: "validate",
        safeMessage: "The capability-probe timeout is invalid."
      })
    );
  }
  return timeout;
}

function exactEndpoint(profile: RuntimeProviderProfile, input: CapabilityProbeInput): string {
  if (input.transport === "single-endpoint-json") {
    return profile.normalizedEndpoints.generationEndpoint;
  }
  if (input.transport === "openai-responses") {
    if (!profile.normalizedEndpoints.responsesEndpoint) {
      throw new ProviderIntegrationError(
        createProviderServiceError({
          code: "config_missing",
          stage: "configure",
          safeMessage: "This provider profile has no explicitly configured Responses endpoint."
        })
      );
    }
    return profile.normalizedEndpoints.responsesEndpoint;
  }
  return profile.normalizedEndpoints.generationEndpoint;
}

function validateProbeShape(input: CapabilityProbeInput): CapabilityProbeDefinition {
  const definition = CAPABILITY_PROBE_DEFINITIONS.find(
    (candidate) =>
      candidate.transport === input.transport &&
      candidate.requestShape === input.requestShape &&
      candidate.capability === input.capability
  );
  if (definition === undefined) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_request",
        stage: "validate",
        safeMessage: "This capability cannot be conclusively proven by one exact confirmed request.",
        capability: input.capability,
        details: {
          transport: input.transport,
          requestShape: input.requestShape,
          capability: input.capability
        }
      })
    );
  }
  return definition;
}

function jsonProbeBody(input: CapabilityProbeInput): string {
  const synthetic = createDeterministicSyntheticPngInputs();
  const common = {
    model: input.model,
    prompt: "Routego capability probe: generate one synthetic checkerboard image."
  };
  const controls = {
    ...(input.capability === "native-variants" ? { n: 2 } : {}),
    ...(input.capability === "custom-size" ? { size: customProbeSize(input).value } : {}),
    ...(input.capability === "quality-control" ? { quality: input.requestedQuality } : {}),
    ...(input.capability === "output-format" ? { output_format: "jpeg" } : {}),
    ...(input.capability === "native-transparency" ? { background: "transparent" } : {})
  };
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImage) {
    return JSON.stringify({ ...common, ...controls, image: synthetic.image.dataUrl });
  }
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImages) {
    return JSON.stringify({
      ...common,
      ...controls,
      images: [synthetic.image.dataUrl, synthetic.mask.dataUrl]
    });
  }
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.responsesImageGeneration) {
    const imageCount = input.capability === "multi-image-input"
      ? 2
      : new Set<ProviderCapability>([
          "single-image-input",
          "data-url-input"
        ]).has(input.capability)
        ? 1
        : 0;
    const content = [
      { type: "input_text", text: common.prompt },
      ...(imageCount >= 1
        ? [{ type: "input_image", image_url: synthetic.image.dataUrl }]
        : []),
      ...(imageCount >= 2
        ? [{ type: "input_image", image_url: synthetic.mask.dataUrl }]
        : [])
    ];
    return JSON.stringify({
      model: input.model,
      input: [{ role: "user", content }],
      tools: [{
        type: "image_generation",
        action: input.capability === "text-generation"
            ? "generate"
            : "auto"
      }]
    });
  }
  return JSON.stringify({ ...common, ...controls });
}

function requestDescriptor(
  profile: RuntimeProviderProfile,
  input: CapabilityProbeInput
): CapabilityProbeRequestDescriptor {
  const endpoint = exactEndpoint(profile, input);
  const authorization = `Bearer ${profile.credential}`;
  return {
    endpoint,
    request: {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json"
      },
      body: jsonProbeBody(input)
    }
  };
}

function responseShape(response: Response): string {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return `http:${response.status};content-type:${(type || "unknown").slice(0, 100)}`;
}

function errorCodeFromBody(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const error = record["error"];
  const candidate =
    typeof record["code"] === "string"
      ? record["code"]
      : error !== null && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>)["code"]
        : undefined;
  return typeof candidate === "string" && candidate.length <= 200 ? candidate : undefined;
}

function unsupportedProviderCode(code: string | undefined): boolean {
  return code !== undefined && /(?:not[_-]?supported|unsupported|unknown[_-]?(?:parameter|feature|endpoint))/iu.test(code);
}

function moderationProviderCode(code: string | undefined): boolean {
  return code !== undefined && /moderation|content[_-]?policy|safety/iu.test(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ProbeImageOutput {
  readonly kind: "inline" | "url";
  readonly url?: string;
  readonly mimeType?: "image/png" | "image/jpeg" | "image/webp";
  readonly width?: number;
  readonly height?: number;
  readonly hasTransparency?: boolean;
}

interface BoundedPngHeader {
  readonly width: number;
  readonly height: number;
  readonly decodedRgbaBytes: number;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IHDR_TOTAL_BYTES = 33;
const PNG_8_BIT_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);

function pngCrc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let position = start; position < end; position += 1) {
    crc ^= bytes[position]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function boundedPngHeader(bytes: Buffer): BoundedPngHeader | undefined {
  if (
    bytes.byteLength < PNG_IHDR_TOTAL_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(29) !== pngCrc32(bytes, 12, 29)
  ) {
    return undefined;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compressionMethod = bytes[26];
  const filterMethod = bytes[27];
  const interlaceMethod = bytes[28];
  if (
    width < 1 ||
    height < 1 ||
    bitDepth !== 8 ||
    colorType === undefined ||
    !PNG_8_BIT_COLOR_TYPES.has(colorType) ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    interlaceMethod !== 0
  ) {
    return undefined;
  }
  const pixels = width * height;
  const decodedRgbaBytes = pixels * 4;
  if (
    !Number.isSafeInteger(pixels) ||
    !Number.isSafeInteger(decodedRgbaBytes) ||
    width > MAX_CAPABILITY_PROBE_PNG_DIMENSION ||
    height > MAX_CAPABILITY_PROBE_PNG_DIMENSION ||
    pixels > MAX_CAPABILITY_PROBE_PNG_PIXELS ||
    decodedRgbaBytes > MAX_CAPABILITY_PROBE_PNG_RGBA_BYTES
  ) {
    return undefined;
  }
  return { width, height, decodedRgbaBytes };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

function jpegDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let position = 2;
  let width: number | undefined;
  let height: number | undefined;
  let sawScan = false;
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) return undefined;
    while (position < bytes.length && bytes[position] === 0xff) position += 1;
    const marker = bytes[position];
    if (marker === undefined) return undefined;
    position += 1;
    if (marker === 0xd9) {
      return sawScan && width !== undefined && height !== undefined && position === bytes.length
        ? { width, height }
        : undefined;
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      return undefined;
    }
    if (position + 2 > bytes.length) return undefined;
    const segmentLength = bytes.readUInt16BE(position);
    if (segmentLength < 2 || position + segmentLength > bytes.length) return undefined;
    const dataStart = position + 2;
    const segmentEnd = position + segmentLength;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) return undefined;
      height = bytes.readUInt16BE(dataStart + 1);
      width = bytes.readUInt16BE(dataStart + 3);
      if (width < 1 || height < 1 || width > 65_535 || height > 65_535) return undefined;
    }
    position = segmentEnd;
    if (marker !== 0xda) continue;
    if (width === undefined || height === undefined) return undefined;
    sawScan = true;
    while (position < bytes.length) {
      if (bytes[position] !== 0xff) {
        position += 1;
        continue;
      }
      let next = position + 1;
      while (next < bytes.length && bytes[next] === 0xff) next += 1;
      const scanMarker = bytes[next];
      if (scanMarker === undefined) return undefined;
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        position = next + 1;
        continue;
      }
      break;
    }
  }
  return undefined;
}

function webpDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 30 || !bytes.subarray(0, 4).equals(Buffer.from("RIFF")) || !bytes.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return undefined;
  }
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const width = 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8));
    const height = 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10));
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

function strictBase64Bytes(value: string): Uint8Array | undefined {
  const encoded = value.startsWith("data:")
    ? /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value)?.[1]
    : value;
  if (
    encoded === undefined ||
    encoded.length === 0 ||
    encoded.length > Math.ceil(MAX_CAPABILITY_PROBE_SUCCESS_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPABILITY_PROBE_SUCCESS_BYTES) {
    return undefined;
  }
  const normalizedInput = encoded.replace(/=+$/u, "");
  const normalizedOutput = bytes.toString("base64").replace(/=+$/u, "");
  return normalizedInput === normalizedOutput ? new Uint8Array(bytes) : undefined;
}

function inspectInlineImage(value: string): ProbeImageOutput | undefined {
  const bytes = strictBase64Bytes(value);
  if (bytes === undefined) return undefined;
  const pngBytes = Buffer.from(bytes);
  if (pngBytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    const header = boundedPngHeader(pngBytes);
    if (header === undefined) return undefined;
    try {
      const decoded = PNG.sync.read(pngBytes);
      if (
        decoded.width !== header.width ||
        decoded.height !== header.height ||
        decoded.data.byteLength !== header.decodedRgbaBytes
      ) {
        return undefined;
      }
      let hasTransparency = false;
      for (let offset = 3; offset < decoded.data.length; offset += 4) {
        if (decoded.data[offset] !== 255) {
          hasTransparency = true;
          break;
        }
      }
      return {
        kind: "inline",
        mimeType: "image/png",
        width: decoded.width,
        height: decoded.height,
        hasTransparency
      };
    } catch {
      return undefined;
    }
  }
  const jpeg = jpegDimensions(Buffer.from(bytes));
  if (jpeg !== undefined) {
    return { kind: "inline", mimeType: "image/jpeg", ...jpeg };
  }
  const webp = webpDimensions(Buffer.from(bytes));
  if (webp !== undefined) {
    return { kind: "inline", mimeType: "image/webp", ...webp };
  }
  return undefined;
}

function inspectOutputUrl(value: string): ProbeImageOutput | undefined {
  if (value.length === 0 || value.length > 4_096) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return undefined;
    }
    return { kind: "url", url: parsed.href };
  } catch {
    return undefined;
  }
}

function imageOutputFromItem(item: unknown): ProbeImageOutput | undefined {
  if (!isRecord(item)) return undefined;
  const base64 = ["b64_json", "b64", "base64", "image_base64"]
    .map((key) => typeof item[key] === "string" ? item[key] : undefined)
    .find((value) => value !== undefined);
  const url = ["url", "image_url", "imageUrl"]
    .map((key) => typeof item[key] === "string" ? item[key] : undefined)
    .find((value) => value !== undefined);
  const image = typeof item["image"] === "string" ? item["image"] : undefined;
  const encoded = base64 ?? (image !== undefined && !image.startsWith("http") ? image : undefined);
  const resource = url ?? (image !== undefined && image.startsWith("http") ? image : undefined);
  if ((encoded === undefined) === (resource === undefined)) return undefined;
  if (encoded !== undefined) return inspectInlineImage(encoded);
  // Some OpenAI-compatible relays put a data:image URL in the `url` field.
  // Decode it as image bytes before treating it as a network resource.
  return inspectInlineImage(resource!) ?? inspectOutputUrl(resource!);
}

function imageOutputItems(body: Record<string, unknown>): readonly unknown[] | undefined {
  const candidates = [body["data"], body["images"], body["result"]];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length >= 1 && candidate.length <= 4) return candidate;
    if (!isRecord(candidate)) continue;
    for (const nested of [candidate["data"], candidate["images"], candidate["result"]]) {
      if (Array.isArray(nested) && nested.length >= 1 && nested.length <= 4) return nested;
    }
    return [candidate];
  }
  return undefined;
}

function imagesOutputs(body: unknown): readonly ProbeImageOutput[] | undefined {
  if (!isRecord(body)) return undefined;
  const data = imageOutputItems(body);
  if (data === undefined) return undefined;
  const outputs: ProbeImageOutput[] = [];
  for (const item of data) {
    const output = imageOutputFromItem(item);
    if (output === undefined) return undefined;
    outputs.push(output);
  }
  return outputs;
}

function responsesOutputs(body: unknown): readonly ProbeImageOutput[] | undefined {
  if (
    !isRecord(body) ||
    body["status"] !== "completed" ||
    !Array.isArray(body["output"])
  ) {
    return undefined;
  }
  const outputs: ProbeImageOutput[] = [];
  for (const item of body["output"]) {
    if (
      !isRecord(item) ||
      item["type"] !== "image_generation_call" ||
      item["status"] !== "completed" ||
      typeof item["result"] !== "string"
    ) {
      continue;
    }
    const output = inspectInlineImage(item["result"]);
    if (output !== undefined) outputs.push(output);
  }
  return outputs.length > 0 && outputs.length <= 4 ? outputs : undefined;
}

function customProbeSize(input: CapabilityProbeInput): {
  readonly value: string;
  readonly width: number;
  readonly height: number;
} {
  const value = input.capability === "custom-size" && input.requestedSize !== undefined && input.requestedSize !== "auto"
    ? input.requestedSize
    : "256x256";
  const match = /^(?<width>[1-9]\d{1,4})x(?<height>[1-9]\d{1,4})$/u.exec(value);
  const width = Number(match?.groups?.["width"]);
  const height = Number(match?.groups?.["height"]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > MAX_CAPABILITY_PROBE_PNG_DIMENSION ||
    height > MAX_CAPABILITY_PROBE_PNG_DIMENSION ||
    width * height > MAX_CAPABILITY_PROBE_PNG_PIXELS
  ) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_request",
        stage: "validate",
        safeMessage: "The requested probe size exceeds Routego's bounded verification limit.",
        capability: input.capability,
        details: { requestedSize: value }
      })
    );
  }
  return { value, width, height };
}

async function resolveProbeUrls(
  outputs: readonly ProbeImageOutput[],
  endpoint: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<readonly ProbeImageOutput[]> {
  return Promise.all(outputs.map(async (output) => {
    if (output.kind !== "url" || output.url === undefined) return output;
    const downloaded = await downloadProviderImage(output.url, {
      fetch: fetchImpl,
      providerEndpoint: endpoint,
      maximumBytes: MAX_CAPABILITY_PROBE_SUCCESS_BYTES,
      timeoutMs
    });
    return {
      kind: "inline" as const,
      mimeType: downloaded.mimeType,
      width: downloaded.width,
      height: downloaded.height,
      hasTransparency: downloaded.hasAlpha
    };
  }));
}

function responseProvesCapability(
  outputs: readonly ProbeImageOutput[] | undefined,
  proof: ProbeResponseProof,
  expectedSize: { readonly width: number; readonly height: number }
): boolean {
  if (outputs === undefined) return false;
  switch (proof) {
    case "images-output":
    case "images-quality-control":
    case "responses-completed-output":
      return outputs.length >= 1;
    case "images-two-outputs":
      return outputs.length >= 2;
    case "images-custom-size":
      return outputs.every(
        (output) => output.width === expectedSize.width && output.height === expectedSize.height
      );
    case "images-jpeg-output":
      return outputs.every((output) => output.mimeType === "image/jpeg");
    case "images-alpha-output":
      return outputs.every(
        (output) => output.mimeType === "image/png" && output.hasTransparency === true
      );
  }
}

function responseBodyShape(body: unknown): string {
  if (!isRecord(body)) return Array.isArray(body) ? "top-level-array" : typeof body;
  const keys = Object.keys(body)
    .filter((key) => /^[A-Za-z0-9_:-]{1,48}$/u.test(key))
    .sort()
    .slice(0, 8);
  const data = body["data"];
  const dataShape = Array.isArray(data)
    ? "array"
    : data === null
      ? "null"
      : typeof data;
  const firstItem = Array.isArray(data) ? data[0] : undefined;
  const firstItemKeys = isRecord(firstItem)
    ? Object.keys(firstItem)
      .filter((key) => /^[A-Za-z0-9_:-]{1,48}$/u.test(key))
      .sort()
      .slice(0, 8)
    : [];
  return `object(${keys.join(",") || "no-safe-keys"});data=${dataShape}${firstItemKeys.length === 0 ? "" : `;data0=object(${firstItemKeys.join(",")})`}`;
}

function probeInconclusiveMessage(reason: string, body?: unknown): string {
  switch (reason) {
    case "returned-image-url-could-not-be-verified":
      return "The provider accepted the request, but Routego could not safely read the returned test-image URL to verify pixels.";
    case "returned-image-url-inspection-failed":
      return "The provider returned a test-image URL that Routego could not inspect to verify pixels.";
    case "capability-specific-proof-missing":
      return `The provider accepted the request but did not return a recognizable image output for pixel verification (response ${responseBodyShape(body)}).`;
    default:
      return "The confirmed capability probe returned no conclusive capability evidence.";
  }
}

function inconclusiveSuccess(response: Response, reason: string, body?: unknown): CapabilityProbeOutcome {
  return {
    outcome: "transient",
    error: createProviderServiceError({
      code: "invalid_response",
      stage: "complete",
      safeMessage: probeInconclusiveMessage(reason, body),
      httpStatus: response.status,
      mayHaveBilled: true,
      details: {
        responseShape: responseShape(response),
        reason
      }
    })
  };
}

async function defaultInterpretResponse(
  response: Response,
  definition: CapabilityProbeDefinition,
  options: {
    readonly endpoint: string;
    readonly fetch: typeof fetch;
    readonly timeoutMs: number;
    readonly expectedSize: { readonly width: number; readonly height: number };
  }
): Promise<CapabilityProbeOutcome> {
  const shape = responseShape(response);
  if (response.ok) {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      await response.body?.cancel("inconclusive-probe-response").catch(() => undefined);
      return inconclusiveSuccess(response, "success-content-type-not-json");
    }
    let body: unknown;
    try {
      const bytes = await readBoundedResponseBytes(response, MAX_CAPABILITY_PROBE_SUCCESS_BYTES);
      if (bytes.byteLength === 0) return inconclusiveSuccess(response, "empty-success-body");
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return inconclusiveSuccess(response, "invalid-or-oversized-success-body");
    }
    const parsedOutputs = definition.responseProof === "responses-completed-output"
      ? responsesOutputs(body)
      : imagesOutputs(body);
    let outputs = parsedOutputs;
    if (outputs?.some((output) => output.kind === "url") === true) {
      try {
        outputs = await resolveProbeUrls(outputs, options.endpoint, options.fetch, options.timeoutMs);
      } catch (error) {
        if (definition.responseProof === "images-custom-size" && error instanceof ProviderDownloadException) {
          return {
            outcome: "degraded",
            degradedReason: "The provider accepted the requested size, but Routego could not safely read the returned test image to verify its pixels."
          };
        }
        return inconclusiveSuccess(
          response,
          error instanceof ProviderDownloadException
            ? "returned-image-url-could-not-be-verified"
            : "returned-image-url-inspection-failed"
        );
      }
    }
    if (!responseProvesCapability(outputs, definition.responseProof, options.expectedSize)) {
      return inconclusiveSuccess(response, "capability-specific-proof-missing", body);
    }
    const declaredState = response.headers.get("x-routego-capability-state")?.trim().toLowerCase();
    if (declaredState === "degraded") {
      const reason = response.headers.get("x-routego-degraded-reason")?.trim();
      return {
        outcome: "degraded",
        degradedReason: reason && reason.length <= 500
          ? redactProviderText(reason)
          : "The provider completed only a weaker confirmed fallback."
      };
    }
    return { outcome: "supported" };
  }
  let providerCode: string | undefined;
  try {
    const bytes = await readBoundedResponseBytes(response, MAX_CAPABILITY_PROBE_ERROR_BYTES);
    if (bytes.byteLength > 0) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      providerCode = errorCodeFromBody(JSON.parse(text) as unknown);
    }
  } catch {
    // Oversized or malformed provider bodies are intentionally discarded.
  }
  if (
    response.status === 404 ||
    response.status === 405 ||
    response.status === 415 ||
    response.status === 501 ||
    ((response.status === 400 || response.status === 422) && unsupportedProviderCode(providerCode))
  ) {
    return { outcome: "unsupported", ...(providerCode ? { providerCode } : {}) };
  }
  const code = response.status === 401 || response.status === 403
    ? "auth_failed"
    : response.status === 429
      ? "rate_limited"
      : response.status === 408
        ? "timeout"
        : response.status >= 500
          ? "provider_5xx"
          : moderationProviderCode(providerCode)
            ? "moderation_blocked"
            : "invalid_response";
  return {
    outcome: "transient",
    ...(providerCode ? { providerCode } : {}),
    error: createProviderServiceError({
      code,
      stage: "submit",
      safeMessage: "The confirmed capability probe did not produce conclusive capability evidence.",
      httpStatus: response.status,
      ...(providerCode === undefined ? {} : { providerCode }),
      mayHaveBilled: true,
      details: { responseShape: shape }
    })
  };
}

function matchingRecord(
  profile: RuntimeProviderProfile,
  input: CapabilityProbeInput,
  endpointFingerprint: string
): ProviderCapabilityRecord | undefined {
  return profile.capabilities.find(
    (record) =>
      record.capability === input.capability &&
      record.scope.providerId === input.providerId &&
      record.scope.model === input.model &&
      record.scope.endpointFingerprint === endpointFingerprint &&
      record.scope.transport === input.transport &&
      record.scope.requestShape === input.requestShape
  );
}

function evidence(input: {
  readonly source: CapabilityEvidence["source"];
  readonly observedAt: string;
  readonly summary: string;
  readonly requestShape: string;
  readonly responseShape?: string;
  readonly httpStatus?: number;
  readonly providerCode?: string;
}): CapabilityEvidence {
  return {
    source: input.source,
    observedAt: input.observedAt,
    summary: input.summary,
    requestShape: input.requestShape,
    ...(input.responseShape === undefined ? {} : { responseShape: input.responseShape }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.providerCode === undefined
      ? {}
      : { details: boundedRedactedDiagnostic({ providerCode: input.providerCode }) })
  };
}

async function persistedTransientRecord(
  owner: CapabilityProbeOwner,
  profile: RuntimeProviderProfile,
  result: CapabilityProbeResult,
  endpointFingerprint: string
): Promise<ProviderCapabilityRecord> {
  await owner.persistCapabilityProbe(result);
  const refreshed = await owner.getRuntimeProviderProfile(profile.id);
  return matchingRecord(
    refreshed,
    {
      schemaVersion: 1,
      providerId: result.providerId,
      model: result.model,
      capability: result.record.capability,
      transport: result.record.scope.transport,
      requestShape: result.record.scope.requestShape,
      confirmBillableProbe: true
    },
    endpointFingerprint
  ) ?? result.record;
}

export async function probeProviderCapability(
  owner: CapabilityProbeOwner,
  input: CapabilityProbeInput,
  options: ProbeProviderCapabilityOptions = {}
): Promise<CapabilityProbeResult> {
  const parsedResult = capabilityProbeInputSchema.safeParse(input);
  if (!parsedResult.success) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_request",
        stage: "validate",
        safeMessage: "A capability probe requires literal confirmation for one exact request shape."
      })
    );
  }
  const parsed = parsedResult.data;
  const decision = evaluateCapabilityProbe({
    kind: "live-provider",
    mayGenerateOutput: true,
    mayCharge: true,
    confirmedByUser: parsed.confirmBillableProbe
  });
  if (!decision.allowed) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_request",
        stage: "validate",
        safeMessage: "The billable capability probe was not explicitly confirmed."
      })
    );
  }
  const definition = validateProbeShape(parsed);
  const expectedSize = customProbeSize(parsed);
  let profile: RuntimeProviderProfile;
  try {
    profile = await owner.getRuntimeProviderProfile(parsed.providerId);
  } catch (error) {
    throw new ProviderIntegrationError(
      toProviderServiceError(error, {
        code: "config_missing",
        stage: "configure",
        safeMessage: "The selected provider profile is unavailable."
      }),
      { cause: error }
    );
  }
  if (!profile.credential) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "config_missing",
        stage: "configure",
        safeMessage: "The selected provider profile has no API key."
      })
    );
  }
  if (
    profile.models.length > 0 &&
    !profile.models.includes(parsed.model) &&
    profile.defaultModel !== parsed.model
  ) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_input",
        stage: "configure",
        safeMessage: "The probe model is not available to the selected provider profile."
      })
    );
  }
  const descriptor = requestDescriptor(profile, parsed);
  const endpointFingerprint = fingerprintProviderEndpoint(descriptor.endpoint);
  const scope = {
    providerId: parsed.providerId,
    model: parsed.model,
    endpointFingerprint,
    transport: parsed.transport,
    requestShape: parsed.requestShape
  } as const;
  const current = matchingRecord(profile, parsed, endpointFingerprint) ??
    createUnknownCapabilityRecord(parsed.capability, scope);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("capability-probe-timeout"),
    safeTimeout(options.timeoutMs)
  );
  let response: Response | undefined;
  let outcome: CapabilityProbeOutcome | undefined;
  try {
    try {
      response = await (options.fetch ?? globalThis.fetch)(descriptor.endpoint, {
        ...descriptor.request,
        signal: controller.signal
      });
    } catch (error) {
      outcome = {
        outcome: "transient",
        error: createProviderServiceError({
          code: controller.signal.aborted ? "timeout" : "invalid_response",
          stage: "submit",
          safeMessage: controller.signal.aborted
            ? "The confirmed capability probe timed out."
            : "The confirmed capability probe could not reach the provider.",
          mayHaveBilled: true,
          details: error
        })
      };
    }
    if (response) {
      outcome = await defaultInterpretResponse(response, definition, {
        endpoint: descriptor.endpoint,
        fetch: options.fetch ?? globalThis.fetch,
        timeoutMs: safeTimeout(options.timeoutMs),
        expectedSize
      });
    }
  } finally {
    clearTimeout(timeout);
  }
  if (outcome === undefined) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "internal_contract",
        stage: "complete",
        safeMessage: "The capability probe did not produce a bounded outcome.",
        mayHaveBilled: response !== undefined
      })
    );
  }
  const finalOutcome = outcome;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const shape = response === undefined ? undefined : responseShape(response);
  const status = response?.status;
  if (finalOutcome.outcome === "transient") {
    const observation = evidence({
      source: "transient-failure",
      observedAt,
      summary: "A transient provider failure preserved the prior scoped capability state.",
      requestShape: parsed.requestShape,
      ...(shape === undefined ? {} : { responseShape: shape }),
      ...(status === undefined ? {} : { httpStatus: status }),
      ...(finalOutcome.providerCode === undefined
        ? {}
        : { providerCode: finalOutcome.providerCode })
    });
    const transient = capabilityProbeResultSchema.parse({
      schemaVersion: 1,
      providerId: parsed.providerId,
      model: parsed.model,
      status: "failed",
      record: createUnknownCapabilityRecord(parsed.capability, scope, [observation]),
      mayHaveBilled: true,
      error: finalOutcome.error
    });
    let record: ProviderCapabilityRecord;
    try {
      record = await persistedTransientRecord(owner, profile, transient, endpointFingerprint);
    } catch (error) {
      throw new ProviderIntegrationError(
        toProviderServiceError(error, {
          code: "file_write_failed",
          stage: "persist",
          safeMessage: "The capability-probe evidence could not be saved.",
          mayHaveBilled: true
        }),
        { cause: error }
      );
    }
    return capabilityProbeResultSchema.parse({ ...transient, record });
  }
  const customSizeLimits = parsed.capability === "custom-size"
    ? { supportedSizes: [expectedSize.value] }
    : undefined;
  const qualityLimits = parsed.capability === "quality-control" && parsed.requestedQuality !== undefined
    ? { supportedQualities: [parsed.requestedQuality] }
    : undefined;
  const observation = finalOutcome.outcome === "supported"
    ? {
        outcome: "supported" as const,
        evidence: evidence({
          source: "successful-request",
          observedAt,
          summary: "The confirmed provider request conclusively accepted this exact capability shape.",
          requestShape: parsed.requestShape,
          ...(shape === undefined ? {} : { responseShape: shape }),
          ...(status === undefined ? {} : { httpStatus: status })
        }),
        ...(customSizeLimits === undefined && qualityLimits === undefined
          ? {}
          : { limits: { ...customSizeLimits, ...qualityLimits } })
      }
    : finalOutcome.outcome === "unsupported"
      ? {
          outcome: "unsupported" as const,
          evidence: evidence({
            source: "protocol-rejection",
            observedAt,
            summary: "The provider returned a stable protocol-level rejection for this exact capability shape.",
            requestShape: parsed.requestShape,
            ...(shape === undefined ? {} : { responseShape: shape }),
            ...(status === undefined ? {} : { httpStatus: status }),
            ...(finalOutcome.providerCode === undefined
              ? {}
              : { providerCode: finalOutcome.providerCode })
          })
        }
      : {
          outcome: "degraded" as const,
          degradedReason: redactProviderText(finalOutcome.degradedReason),
          evidence: evidence({
            source: "degraded-fallback",
            observedAt,
            summary: "The confirmed provider path completed only with weaker semantics.",
            requestShape: parsed.requestShape,
          ...(shape === undefined ? {} : { responseShape: shape }),
          ...(status === undefined ? {} : { httpStatus: status })
        }),
        ...(customSizeLimits === undefined && qualityLimits === undefined
          ? {}
          : { limits: { ...customSizeLimits, ...qualityLimits } })
      };
  const record = transitionCapability(current, observation);
  const result = capabilityProbeResultSchema.parse({
    schemaVersion: 1,
    providerId: parsed.providerId,
    model: parsed.model,
    status: "completed",
    record,
    mayHaveBilled: true
  });
  try {
    await owner.persistCapabilityProbe(result);
  } catch (error) {
    throw new ProviderIntegrationError(
      toProviderServiceError(error, {
        code: "file_write_failed",
        stage: "persist",
        safeMessage: "The capability-probe evidence could not be saved.",
        mayHaveBilled: true
      }),
      { cause: error }
    );
  }
  return result;
}
