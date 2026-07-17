import { createHash } from "node:crypto";

import {
  imageArtifactSchema,
  imageRelationshipSchema,
  routegoServiceErrorSchema,
  type ImageArtifact,
  type ImageRelationship,
  type RoutegoServiceError
} from "@routego-image/contracts";
import { redactDiagnostic, redactFreeText, type SelectedProviderRoute } from "@routego-image/foundation";

import {
  ProviderDownloadException,
  downloadProviderImage,
  type ProviderImageDownloadOptions
} from "./downloads";
import {
  invalidProviderResponseError,
  mapProviderHttpError,
  providerReportedFailure,
  providerStreamError
} from "./errors";
import { detectImageMetadata, imageDataUrl } from "./image-inputs";
import { SseDecodingError, SseDecoder, parseSseJson } from "./sse";
import {
  MAX_PROVIDER_INPUT_BYTES,
  type PreparedImageInputs,
  type SupportedImageMimeType
} from "./types";

interface DecodedProviderImage {
  readonly bytes: Uint8Array;
  readonly dataUrl: string;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}

export interface ProviderResponseParseContext {
  readonly requestId: string;
  readonly route: SelectedProviderRoute;
  readonly inputs?: PreparedImageInputs;
  readonly fetch?: typeof fetch;
  readonly authorization?: string;
  readonly explicitSameOriginAuthorization?: boolean;
  readonly maximumImageBytes?: number;
  readonly maximumBodyBytes?: number;
  readonly maximumRedirects?: number;
  readonly downloadTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly onPartialArtifact?: (artifact: ImageArtifact) => void | Promise<void>;
}

export interface NormalizedProviderResponse {
  readonly finalArtifacts: readonly ImageArtifact[];
  readonly partialArtifacts: readonly ImageArtifact[];
  readonly relationships: readonly ImageRelationship[];
  readonly providerImageIds: readonly string[];
  readonly revisedPrompts: readonly string[];
  readonly receivedAnyOutput: boolean;
  readonly mayHaveBilled: boolean;
  readonly providerResponseId?: string;
  readonly error?: RoutegoServiceError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeProviderId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ? value
    : undefined;
}

function requestFingerprint(requestId: string): string {
  return createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16);
}

function artifactIdentifier(
  requestId: string,
  phase: "partial" | "final",
  slot: number,
  partialIndex = 0
): string {
  return `artifact:${requestFingerprint(requestId)}:${phase}:${slot}:${partialIndex}`;
}

function decodeBase64Payload(value: string, maximumBytes: number): DecodedProviderImage {
  const dataUrl = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u);
  const encoded = dataUrl?.[2] ?? value;
  if (
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) {
    throw new Error("invalid-base64");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const approximateBytes = encoded.length % 4 === 0
    ? (encoded.length / 4) * 3 - padding
    : Math.floor((encoded.length * 3) / 4);
  if (approximateBytes > maximumBytes) {
    throw new Error("oversize-base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/u, "");
  if (canonical !== encoded.replace(/=+$/u, "") || bytes.byteLength > maximumBytes) {
    throw new Error(bytes.byteLength > maximumBytes ? "oversize-base64" : "invalid-base64");
  }
  const metadata = detectImageMetadata(bytes);
  if (dataUrl !== null && `image/${dataUrl[1]}` !== metadata.mimeType) {
    throw new Error("mime-mismatch");
  }
  return {
    bytes,
    dataUrl: imageDataUrl({ bytes, mimeType: metadata.mimeType }),
    ...metadata,
    byteLength: bytes.byteLength
  };
}

export function decodeProviderImageBase64(
  value: string,
  maximumBytes = MAX_PROVIDER_INPUT_BYTES
): DecodedProviderImage {
  return decodeBase64Payload(value, maximumBytes);
}

function createArtifact(
  decoded: DecodedProviderImage,
  context: ProviderResponseParseContext,
  slot: number,
  phase: "partial" | "final",
  providerImageId?: string,
  partialIndex = 0
): ImageArtifact {
  const now = context.now?.() ?? new Date();
  return imageArtifactSchema.parse({
    id: artifactIdentifier(context.requestId, phase, slot, partialIndex),
    slot,
    phase,
    mimeType: decoded.mimeType,
    byteLength: decoded.byteLength,
    width: decoded.width,
    height: decoded.height,
    sha256: createHash("sha256").update(decoded.bytes).digest("hex"),
    ...(providerImageId === undefined ? {} : { providerImageId }),
    display: { type: "image", dataUrl: decoded.dataUrl },
    createdAt: now.toISOString()
  });
}

function relationshipRole(input: PreparedImageInputs["images"][number]): "target" | "supporting" | "reference" {
  return input.kind === "target" ? "target" : input.kind === "supporting" ? "supporting" : "reference";
}

function relationshipsFor(
  inputs: PreparedImageInputs | undefined,
  finalArtifacts: readonly ImageArtifact[],
  partialArtifacts: readonly ImageArtifact[]
): ImageRelationship[] {
  const relationships: ImageRelationship[] = [];
  let order = 0;
  for (const artifact of finalArtifacts) {
    for (const input of inputs?.images ?? []) {
      relationships.push(
        imageRelationshipSchema.parse({
          ...(input.id === undefined ? {} : { inputId: input.id }),
          inputRole: relationshipRole(input),
          outputArtifactId: artifact.id,
          order
        })
      );
      order += 1;
    }
    if (inputs?.mask !== undefined) {
      relationships.push(
        imageRelationshipSchema.parse({
          inputRole: "mask",
          outputArtifactId: artifact.id,
          order
        })
      );
      order += 1;
    }
    relationships.push(
      imageRelationshipSchema.parse({
        inputRole: "output",
        outputArtifactId: artifact.id,
        order
      })
    );
    order += 1;
  }
  for (const artifact of partialArtifacts) {
    relationships.push(
      imageRelationshipSchema.parse({
        inputRole: "stream-partial",
        outputArtifactId: artifact.id,
        order
      })
    );
    order += 1;
  }
  return relationships.slice(0, 128);
}

function errorWithOutput(
  error: RoutegoServiceError,
  finalArtifacts: readonly ImageArtifact[],
  partialArtifacts: readonly ImageArtifact[]
): RoutegoServiceError {
  const receivedAnyOutput = finalArtifacts.length > 0 || partialArtifacts.length > 0;
  return routegoServiceErrorSchema.parse({
    ...error,
    retryDisposition: receivedAnyOutput ? "never" : error.retryDisposition,
    partialArtifacts: partialArtifacts.slice(0, 4),
    receivedAnyOutput: receivedAnyOutput || error.receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput || error.mayHaveBilled
  });
}

function normalized(
  context: ProviderResponseParseContext,
  input: {
    readonly finalArtifacts?: readonly ImageArtifact[];
    readonly partialArtifacts?: readonly ImageArtifact[];
    readonly providerImageIds?: readonly string[];
    readonly revisedPrompts?: readonly string[];
    readonly providerResponseId?: string | undefined;
    readonly error?: RoutegoServiceError;
  }
): NormalizedProviderResponse {
  const finalArtifacts = [...(input.finalArtifacts ?? [])].slice(0, 4);
  const partialArtifacts = [...(input.partialArtifacts ?? [])].slice(0, 12);
  const receivedAnyOutput = finalArtifacts.length > 0 || partialArtifacts.length > 0;
  const error = input.error === undefined
    ? undefined
    : errorWithOutput(input.error, finalArtifacts, partialArtifacts);
  return {
    finalArtifacts,
    partialArtifacts,
    relationships: relationshipsFor(context.inputs, finalArtifacts, partialArtifacts),
    providerImageIds: [...new Set(input.providerImageIds ?? [])].slice(0, 16),
    revisedPrompts: [...(input.revisedPrompts ?? [])].slice(0, 4),
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput || error?.mayHaveBilled === true,
    ...(input.providerResponseId === undefined ? {} : { providerResponseId: input.providerResponseId }),
    ...(error === undefined ? {} : { error })
  };
}

function invalidResult(
  context: ProviderResponseParseContext,
  safeMessage: string,
  reason: string,
  outputs: {
    readonly finalArtifacts?: readonly ImageArtifact[];
    readonly partialArtifacts?: readonly ImageArtifact[];
    readonly providerImageIds?: readonly string[];
    readonly providerResponseId?: string | undefined;
  } = {}
): NormalizedProviderResponse {
  return normalized(context, {
    ...outputs,
    error: invalidProviderResponseError(safeMessage, reason, {
      stage: "parse",
      receivedAnyOutput:
        (outputs.finalArtifacts?.length ?? 0) > 0 || (outputs.partialArtifacts?.length ?? 0) > 0,
      mayHaveBilled: true,
      partialArtifacts: outputs.partialArtifacts
    })
  });
}

function downloadOptions(context: ProviderResponseParseContext): ProviderImageDownloadOptions | undefined {
  if (context.fetch === undefined) return undefined;
  return {
    fetch: context.fetch,
    providerEndpoint: context.route.endpoint,
    ...(context.authorization === undefined ? {} : { authorization: context.authorization }),
    ...(context.explicitSameOriginAuthorization === undefined
      ? {}
      : { explicitSameOriginAuthorization: context.explicitSameOriginAuthorization }),
    ...(context.maximumImageBytes === undefined
      ? {}
      : { maximumBytes: context.maximumImageBytes }),
    ...(context.maximumRedirects === undefined
      ? {}
      : { maximumRedirects: context.maximumRedirects }),
    ...(context.downloadTimeoutMs === undefined
      ? {}
      : { timeoutMs: context.downloadTimeoutMs }),
    ...(context.signal === undefined ? {} : { signal: context.signal })
  };
}

async function materializeImage(
  value: string,
  context: ProviderResponseParseContext,
  kind: "auto" | "base64" | "url" = "auto"
): Promise<DecodedProviderImage> {
  if (kind === "url" || (kind === "auto" && /^[a-z][a-z0-9+.-]*:/iu.test(value))) {
    const options = downloadOptions(context);
    if (options === undefined) throw new Error("download-fetch-missing");
    return downloadProviderImage(value, options);
  }
  return decodeBase64Payload(
    value,
    Math.min(context.maximumImageBytes ?? MAX_PROVIDER_INPUT_BYTES, MAX_PROVIDER_INPUT_BYTES)
  );
}

export async function normalizeImagesJsonResponse(
  body: unknown,
  context: ProviderResponseParseContext
): Promise<NormalizedProviderResponse> {
  if (!isRecord(body) || !Array.isArray(body["data"]) || body["data"].length === 0) {
    return invalidResult(context, "The provider returned no image results.", "missing-images-data");
  }
  if (body["data"].length > 4) {
    return invalidResult(context, "The provider returned too many image results.", "too-many-images");
  }

  const finalArtifacts: ImageArtifact[] = [];
  const providerImageIds: string[] = [];
  const revisedPrompts: string[] = [];
  for (const [slot, item] of body["data"].entries()) {
    if (!isRecord(item)) {
      return invalidResult(context, "A provider image result is malformed.", "invalid-image-item", {
        finalArtifacts,
        providerImageIds
      });
    }
    const base64 = typeof item["b64_json"] === "string" ? item["b64_json"] : undefined;
    const url = typeof item["url"] === "string" ? item["url"] : undefined;
    if ((base64 === undefined) === (url === undefined)) {
      return invalidResult(context, "A provider image result is ambiguous or empty.", "ambiguous-image-item", {
        finalArtifacts,
        providerImageIds
      });
    }
    const providerImageId = safeProviderId(item["id"]);
    try {
      const decoded = await materializeImage(base64 ?? url ?? "", context, url === undefined ? "base64" : "url");
      finalArtifacts.push(createArtifact(decoded, context, slot, "final", providerImageId));
      if (providerImageId !== undefined) providerImageIds.push(providerImageId);
      if (typeof item["revised_prompt"] === "string") {
        revisedPrompts.push(redactFreeText(item["revised_prompt"]).slice(0, 32_000));
      }
    } catch (error) {
      const structured = error instanceof ProviderDownloadException
        ? error.error
        : invalidProviderResponseError(
            "A provider image result failed Base64, MIME, magic, or byte-limit validation.",
            error instanceof Error ? error.message : "invalid-image-result",
            {
              stage: url === undefined ? "parse" : "download",
              receivedAnyOutput: finalArtifacts.length > 0,
              mayHaveBilled: true
            }
          );
      return normalized(context, {
        finalArtifacts,
        providerImageIds,
        revisedPrompts,
        error: structured
      });
    }
  }
  return normalized(context, { finalArtifacts, providerImageIds, revisedPrompts });
}

function responseOutputItems(body: Record<string, unknown>): readonly unknown[] {
  return Array.isArray(body["output"]) ? body["output"] : [];
}

export async function normalizeResponsesJsonResponse(
  body: unknown,
  context: ProviderResponseParseContext
): Promise<NormalizedProviderResponse> {
  if (!isRecord(body)) {
    return invalidResult(context, "The Responses provider body is not a JSON object.", "invalid-responses-body");
  }
  const status = typeof body["status"] === "string" ? body["status"] : undefined;
  const providerResponseId = safeProviderId(body["id"]);
  const completed = status === "completed";
  const failed = status === "failed" || status === "incomplete" || body["error"] !== undefined;
  const finalArtifacts: ImageArtifact[] = [];
  const partialArtifacts: ImageArtifact[] = [];
  const providerImageIds: string[] = [];

  for (const [slot, item] of responseOutputItems(body).entries()) {
    if (!isRecord(item) || item["type"] !== "image_generation_call") continue;
    const providerImageId = safeProviderId(item["id"]);
    const result = typeof item["result"] === "string" ? item["result"] : undefined;
    if (result === undefined) continue;
    try {
      const decoded = await materializeImage(result, context);
      const phase = completed && item["status"] === "completed" ? "final" : "partial";
      const artifact = createArtifact(decoded, context, slot, phase, providerImageId);
      if (phase === "final") finalArtifacts.push(artifact);
      else partialArtifacts.push(artifact);
      if (providerImageId !== undefined) providerImageIds.push(providerImageId);
    } catch (error) {
      return invalidResult(
        context,
        "A Responses image result failed Base64, MIME, magic, or byte-limit validation.",
        error instanceof Error ? error.message : "invalid-responses-image",
        { finalArtifacts, partialArtifacts, providerImageIds, providerResponseId }
      );
    }
  }

  if (failed) {
    return normalized(context, {
      finalArtifacts,
      partialArtifacts,
      providerImageIds,
      providerResponseId,
      error: providerReportedFailure(body["error"] ?? body, {
        stage: "parse",
        receivedAnyOutput: finalArtifacts.length > 0 || partialArtifacts.length > 0,
        mayHaveBilled: true,
        partialArtifacts
      })
    });
  }
  if (!completed || finalArtifacts.length === 0) {
    return invalidResult(context, "The Responses provider returned no completed image.", "missing-final-image", {
      finalArtifacts,
      partialArtifacts,
      providerImageIds,
      providerResponseId
    });
  }
  return normalized(context, {
    finalArtifacts,
    partialArtifacts,
    providerImageIds,
    providerResponseId
  });
}

function outputIndex(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : 0;
}

function partialIndex(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : fallback;
}

async function streamChunks(body: ReadableStream<Uint8Array>): Promise<NormalizedProviderResponse["error"] | undefined> {
  if (body.locked) {
    return invalidProviderResponseError("The provider SSE body is already locked.", "locked-stream", {
      stage: "stream",
      mayHaveBilled: true
    });
  }
  return undefined;
}

export async function normalizeResponsesSseResponse(
  body: ReadableStream<Uint8Array>,
  context: ProviderResponseParseContext
): Promise<NormalizedProviderResponse> {
  const lockedError = await streamChunks(body);
  if (lockedError !== undefined) return normalized(context, { error: lockedError });
  const maximumImageBytes = Math.min(
    context.maximumImageBytes ?? MAX_PROVIDER_INPUT_BYTES,
    MAX_PROVIDER_INPUT_BYTES
  );
  const decoder = new SseDecoder({
    maxFrameBytes: Math.ceil(maximumImageBytes * 4 / 3) + 1_048_576
  });
  const reader = body.getReader();
  const finalArtifacts: ImageArtifact[] = [];
  const partialArtifacts: ImageArtifact[] = [];
  const providerImageIds: string[] = [];
  let providerResponseId: string | undefined;
  let failure: RoutegoServiceError | undefined;
  let partialSequence = 0;
  let sawDone = false;
  let readerDone = false;

  const consumeFrame = async (frame: ReturnType<SseDecoder["push"]>[number]): Promise<void> => {
    if (frame.done) {
      sawDone = true;
      return;
    }
    const value = parseSseJson(frame);
    if (!isRecord(value)) throw new SseDecodingError("invalid-json", "The provider SSE event is not a JSON object.");
    const event = frame.event ?? (typeof value["type"] === "string" ? value["type"] : "message");
    if (event === "response.created" || event === "response.completed") {
      const response = isRecord(value["response"]) ? value["response"] : value;
      providerResponseId = safeProviderId(response["id"]) ?? providerResponseId;
      return;
    }
    if (event === "response.image_generation_call.partial_image") {
      if (partialArtifacts.length >= 12) {
        throw new SseDecodingError("frame-too-large", "The provider emitted too many partial images.");
      }
      const encoded = value["partial_image_b64"];
      if (typeof encoded !== "string") {
        throw new SseDecodingError("invalid-json", "A partial-image event is missing image data.");
      }
      const slot = outputIndex(value["output_index"]);
      const index = partialIndex(value["partial_image_index"], partialSequence);
      const providerImageId = safeProviderId(value["item_id"]);
      const decoded = decodeBase64Payload(encoded, context.maximumImageBytes ?? MAX_PROVIDER_INPUT_BYTES);
      const artifact = createArtifact(decoded, context, slot, "partial", providerImageId, index);
      partialArtifacts.push(artifact);
      partialSequence += 1;
      if (providerImageId !== undefined) providerImageIds.push(providerImageId);
      await context.onPartialArtifact?.(artifact);
      return;
    }
    if (event === "response.output_item.done") {
      const item = isRecord(value["item"]) ? value["item"] : undefined;
      if (item?.["type"] !== "image_generation_call" || typeof item["result"] !== "string") return;
      const slot = outputIndex(value["output_index"]);
      const providerImageId = safeProviderId(item["id"]);
      const decoded = decodeBase64Payload(
        item["result"],
        context.maximumImageBytes ?? MAX_PROVIDER_INPUT_BYTES
      );
      finalArtifacts.push(createArtifact(decoded, context, slot, "final", providerImageId));
      if (providerImageId !== undefined) providerImageIds.push(providerImageId);
      return;
    }
    if (event === "error" || event.endsWith(".failed")) {
      failure = providerStreamError(value["error"] ?? value, {
        stage: "stream",
        receivedAnyOutput: finalArtifacts.length > 0 || partialArtifacts.length > 0,
        mayHaveBilled: true,
        partialArtifacts
      });
    }
  };

  try {
    while (!sawDone && failure === undefined) {
      if (context.signal?.aborted === true) {
        failure = invalidProviderResponseError("The provider SSE stream was cancelled.", "cancelled", {
          stage: "stream",
          receivedAnyOutput: finalArtifacts.length > 0 || partialArtifacts.length > 0,
          mayHaveBilled: true,
          partialArtifacts
        });
        break;
      }
      const next = await reader.read();
      if (next.done) {
        readerDone = true;
        break;
      }
      for (const frame of decoder.push(next.value)) {
        await consumeFrame(frame);
        if (frame.done || failure !== undefined) break;
      }
    }
    if (!sawDone && failure === undefined) {
      for (const frame of decoder.finish()) {
        await consumeFrame(frame);
      }
    }
  } catch (error) {
    failure = invalidProviderResponseError(
      "The provider SSE stream could not be decoded safely.",
      error instanceof SseDecodingError ? error.reason : "invalid-stream",
      {
        stage: "stream",
        receivedAnyOutput: finalArtifacts.length > 0 || partialArtifacts.length > 0,
        mayHaveBilled: true,
        partialArtifacts
      }
    );
  } finally {
    if (!readerDone && (sawDone || failure !== undefined)) {
      await reader.cancel();
    }
    reader.releaseLock();
  }

  if (failure !== undefined) {
    return normalized(context, {
      finalArtifacts,
      partialArtifacts,
      providerImageIds,
      providerResponseId,
      error: failure
    });
  }
  if (finalArtifacts.length === 0) {
    return invalidResult(context, "The provider SSE stream returned no final image.", "missing-final-image", {
      finalArtifacts,
      partialArtifacts,
      providerImageIds,
      providerResponseId
    });
  }
  return normalized(context, {
    finalArtifacts,
    partialArtifacts,
    providerImageIds,
    providerResponseId
  });
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("response-body-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    return Math.min(120_000, Math.max(0, Math.round(Number(value) * 1_000)));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(120_000, Math.max(0, date - nowMs));
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return undefined;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

export async function parseProviderResponse(
  response: Response,
  context: ProviderResponseParseContext
): Promise<NormalizedProviderResponse> {
  if (!response.ok) {
    let body: unknown;
    try {
      body = parseJsonBytes(await readBoundedBody(response, 65_536));
    } catch {
      body = { error: { code: "unreadable-error-body" } };
    }
    return normalized(context, {
      error: mapProviderHttpError(response.status, body, {
        stage: "submit",
        receivedAnyOutput: false,
        mayHaveBilled: false,
        retryAfterMs: parseRetryAfter(
          response.headers.get("retry-after"),
          context.now?.().getTime() ?? Date.now()
        )
      })
    });
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    if (context.route.transport !== "openai-responses" || response.body === null) {
      return invalidResult(context, "The selected route cannot parse this SSE response.", "unexpected-sse");
    }
    return normalizeResponsesSseResponse(response.body, context);
  }

  const maximumBodyBytes = context.maximumBodyBytes ??
    Math.ceil((context.maximumImageBytes ?? MAX_PROVIDER_INPUT_BYTES) * 4 * 4 / 3) + 1_048_576;
  let body: unknown;
  try {
    body = parseJsonBytes(await readBoundedBody(response, maximumBodyBytes));
  } catch (error) {
    return invalidResult(
      context,
      "The provider returned invalid, non-UTF-8, or oversized JSON.",
      error instanceof Error ? error.message : "invalid-json-body"
    );
  }
  return context.route.transport === "openai-responses"
    ? normalizeResponsesJsonResponse(body, context)
    : normalizeImagesJsonResponse(body, context);
}

export function redactNormalizedProviderResponse(value: unknown): unknown {
  return redactDiagnostic(value);
}
