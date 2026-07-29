import type { RoutegoServiceError } from "@routego-image/contracts";
import { decideResultDownloadPolicy } from "@routego-image/foundation";

import { detectImageMetadata, imageDataUrl } from "./image-inputs";
import { providerDownloadError } from "./errors";
import {
  MAX_PROVIDER_INPUT_BYTES,
  ProviderPreparationError,
  type SupportedImageMimeType
} from "./types";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

export interface ProviderImageDownloadOptions {
  readonly fetch: typeof fetch;
  readonly providerEndpoint: string;
  readonly authorization?: string;
  readonly explicitSameOriginAuthorization?: boolean;
  readonly maximumBytes?: number;
  readonly maximumRedirects?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DownloadedProviderImage {
  readonly bytes: Uint8Array;
  readonly dataUrl: string;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly redirectCount: number;
}

export class ProviderDownloadException extends Error {
  readonly error: RoutegoServiceError;

  constructor(error: RoutegoServiceError) {
    super(error.safeMessage);
    this.name = "ProviderDownloadException";
    this.error = error;
  }
}

function throwDownload(reason: string, safeMessage: string): never {
  throw new ProviderDownloadException(providerDownloadError(safeMessage, reason));
}

function parseContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const declaredLength = parseContentLength(response);
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    throwDownload("oversize", "The provider image download exceeds the byte limit.");
  }
  if (response.body === null) {
    throwDownload("empty-body", "The provider image download returned an empty body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted === true) {
        throwDownload("cancelled", "The provider image download was cancelled.");
      }
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throwDownload("oversize", "The provider image download exceeds the byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throwDownload("empty-body", "The provider image download returned an empty body.");
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseMime(response: Response): string | undefined {
  const header = response.headers.get("content-type");
  return header?.split(";", 1)[0]?.trim().toLowerCase();
}

interface PreparedDownloadUrl {
  readonly url: string;
  readonly cleartextFallback?: string;
}

function prepareRemoteCleartextUrl(resourceUrl: string): PreparedDownloadUrl {
  let resource: URL;
  try {
    resource = new URL(resourceUrl);
  } catch {
    return { url: resourceUrl };
  }
  if (
    resource.protocol !== "http:" ||
    resource.username !== "" ||
    resource.password !== "" ||
    resource.hostname === "127.0.0.1" ||
    resource.hostname === "[::1]" ||
    resource.hostname === "::1"
  ) {
    return { url: resourceUrl };
  }
  const cleartextFallback = resource.href;
  resource.protocol = "https:";
  return { url: resource.href, cleartextFallback };
}

export async function downloadProviderImage(
  resourceUrl: string,
  options: ProviderImageDownloadOptions
): Promise<DownloadedProviderImage> {
  const maximumBytes = Math.min(options.maximumBytes ?? MAX_PROVIDER_INPUT_BYTES, MAX_PROVIDER_INPUT_BYTES);
  const maximumRedirects = options.maximumRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("download-timeout"));
  }, timeoutMs);

  let preparedUrl = prepareRemoteCleartextUrl(resourceUrl);
  let currentUrl = preparedUrl.url;
  let cleartextFallback = preparedUrl.cleartextFallback;
  let previousUrl: string | undefined;
  let redirectCount = 0;
  try {
    while (true) {
      if (controller.signal.aborted) {
        throwDownload(
          timedOut ? "timeout" : "cancelled",
          timedOut
            ? "The provider image download timed out."
            : "The provider image download was cancelled."
        );
      }
      const decision = decideResultDownloadPolicy({
        resourceUrl: currentUrl,
        providerEndpoint: options.providerEndpoint,
        ...(options.explicitSameOriginAuthorization === undefined
          ? {}
          : { explicitSameOriginAuthorization: options.explicitSameOriginAuthorization }),
        ...(cleartextFallback !== undefined && currentUrl === cleartextFallback
          ? { allowCleartextWithoutAuthorization: true }
          : {}),
        ...(previousUrl === undefined ? {} : { redirectFromUrl: previousUrl })
      });
      if (!decision.allowed) {
        throwDownload(decision.reason, "The provider image URL was rejected by download policy.");
      }
      // Result URLs may be served by an image gateway that performs content
      // negotiation. Requesting only selected raster formats can cause such a
      // gateway to return a resized preview instead of the generated original.
      // Match an ordinary programmatic fetch and validate the returned bytes
      // ourselves below, rather than influencing the provider's rendition.
      const headers = new Headers({ accept: "*/*" });
      if (decision.forwardAuthorization && options.authorization !== undefined) {
        headers.set("authorization", options.authorization);
      }

      let response: Response;
      try {
        response = await options.fetch(currentUrl, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal
        });
      } catch {
        if (
          !timedOut &&
          !controller.signal.aborted &&
          cleartextFallback !== undefined &&
          currentUrl !== cleartextFallback
        ) {
          currentUrl = cleartextFallback;
          continue;
        }
        throwDownload(
          timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "network-failure",
          timedOut
            ? "The provider image download timed out."
            : controller.signal.aborted
              ? "The provider image download was cancelled."
              : "The provider image download failed before a response was received."
        );
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null) {
          throwDownload("redirect-without-location", "The provider image redirect is missing a target.");
        }
        if (redirectCount >= maximumRedirects) {
          throwDownload("too-many-redirects", "The provider image download exceeded the redirect limit.");
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).href;
        } catch {
          throwDownload("invalid-url", "The provider image redirect target is invalid.");
        }
        previousUrl = currentUrl;
        preparedUrl = prepareRemoteCleartextUrl(nextUrl);
        currentUrl = preparedUrl.url;
        cleartextFallback = preparedUrl.cleartextFallback;
        redirectCount += 1;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throwDownload("http-error", "The provider image URL returned an unsuccessful response.");
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedResponseBytes(response, maximumBytes, controller.signal);
      } catch (error) {
        // Some legacy image relays advertise an HTTP result URL while their
        // HTTPS front door returns a body that Node cannot decode. The original
        // URL is a single, unauthenticated retrieval fallback, not a provider
        // request replay. Policy errors such as byte limits must still stop.
        if (
          !(error instanceof ProviderDownloadException) &&
          cleartextFallback !== undefined &&
          currentUrl !== cleartextFallback &&
          !timedOut &&
          !controller.signal.aborted
        ) {
          await response.body?.cancel().catch(() => undefined);
          currentUrl = cleartextFallback;
          continue;
        }
        if (error instanceof ProviderDownloadException) throw error;
        throwDownload(
          timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "body-read-failed",
          timedOut
            ? "The provider image download timed out."
            : controller.signal.aborted
              ? "The provider image download was cancelled."
              : "The provider image download body could not be read."
        );
      }
      let metadata;
      try {
        metadata = detectImageMetadata(bytes);
      } catch (error) {
        if (error instanceof ProviderPreparationError) {
          throwDownload("invalid-image", "The downloaded bytes are not a supported image.");
        }
        throw error;
      }
      const declaredMime = responseMime(response);
      if (
        declaredMime !== undefined &&
        declaredMime !== "application/octet-stream" &&
        declaredMime !== metadata.mimeType &&
        !(
          SUPPORTED_RASTER_MIME_TYPES.has(declaredMime) &&
          SUPPORTED_RASTER_MIME_TYPES.has(metadata.mimeType)
        )
      ) {
        throwDownload("mime-mismatch", "The downloaded image MIME does not match its bytes.");
      }
      return {
        bytes,
        dataUrl: imageDataUrl({ bytes, mimeType: metadata.mimeType }),
        ...metadata,
        byteLength: bytes.byteLength,
        redirectCount
      };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
