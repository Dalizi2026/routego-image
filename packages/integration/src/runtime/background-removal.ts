import { Worker } from "node:worker_threads";

import { PNG } from "pngjs";

import {
  WORKER_MAX_HEIGHT,
  WORKER_MAX_INPUT_BYTES,
  WORKER_MAX_OUTPUT_BYTES,
  WORKER_MAX_PIXELS,
  WORKER_MAX_WIDTH,
  inspectPngAlpha,
  processBackgroundRemovalRequest,
  type BackgroundRemovalWorkerRequest,
  type BackgroundRemovalWorkerResponse
} from "./background-removal-worker";

export const BACKGROUND_REMOVAL_MAX_WIDTH = WORKER_MAX_WIDTH;
export const BACKGROUND_REMOVAL_MAX_HEIGHT = WORKER_MAX_HEIGHT;
export const BACKGROUND_REMOVAL_MAX_PIXELS = WORKER_MAX_PIXELS;
export const BACKGROUND_REMOVAL_MAX_INPUT_BYTES = WORKER_MAX_INPUT_BYTES;
export const BACKGROUND_REMOVAL_MAX_OUTPUT_BYTES = WORKER_MAX_OUTPUT_BYTES;
export const BACKGROUND_REMOVAL_DEFAULT_TIMEOUT_MS = 30_000;

export type BackgroundRemovalFailureCode =
  | "invalid-input"
  | "input-too-large"
  | "output-too-large"
  | "inference-unavailable"
  | "worker-failed"
  | "worker-crashed"
  | "timeout"
  | "cancelled"
  | "quality-gate-failed";

export interface BackgroundRemovalFailure {
  readonly code: BackgroundRemovalFailureCode;
  readonly message: string;
}

export interface BackgroundRemovalSuccess {
  readonly status: "succeeded";
  readonly originalBytes: Uint8Array;
  readonly transparentBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface BackgroundRemovalFailureResult {
  readonly status: "failed" | "cancelled";
  readonly originalBytes: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly error: BackgroundRemovalFailure;
}

export type BackgroundRemovalResult = BackgroundRemovalSuccess | BackgroundRemovalFailureResult;

export interface BackgroundRemovalWorkerLike {
  postMessage(message: BackgroundRemovalWorkerRequest): void;
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): this;
  once(event: "message" | "error" | "exit", listener: (...args: any[]) => void): this;
  removeListener?(event: "message" | "error" | "exit", listener: (...args: any[]) => void): this;
  terminate(): Promise<number> | number;
}

export interface BackgroundRemovalOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly workerFactory?: () => BackgroundRemovalWorkerLike;
  readonly mask?: Uint8Array;
}

interface QueueItem {
  readonly bytes: Uint8Array;
  readonly options: BackgroundRemovalOptions;
  readonly resolve: (result: BackgroundRemovalResult) => void;
  settled: boolean;
}

function resultFailure(
  status: "failed" | "cancelled",
  bytes: Uint8Array,
  error: BackgroundRemovalFailure,
  width?: number,
  height?: number
): BackgroundRemovalFailureResult {
  return {
    status,
    originalBytes: new Uint8Array(bytes),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    error
  };
}

function parseBoundedPng(bytes: Uint8Array, maxInputBytes: number): { width: number; height: number } | BackgroundRemovalFailure {
  if (bytes.byteLength === 0 || bytes.byteLength > maxInputBytes || bytes.byteLength > BACKGROUND_REMOVAL_MAX_INPUT_BYTES) {
    return { code: "input-too-large", message: "The local background-removal input exceeds the byte limit." };
  }
  if (bytes.byteLength < 33 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71 ||
      bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10) {
    return { code: "invalid-input", message: "The local background-removal input is not a valid PNG." };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = new TextDecoder().decode(bytes.subarray(12, 16));
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const pixels = width * height;
  if (view.getUint32(8) !== 13 || header !== "IHDR" || width < 1 || height < 1 || width > BACKGROUND_REMOVAL_MAX_WIDTH ||
      height > BACKGROUND_REMOVAL_MAX_HEIGHT || bytes[24] !== 8 || !new Set([0, 2, 3, 4, 6]).has(bytes[25] ?? -1) ||
      bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0 || !Number.isSafeInteger(pixels) || pixels > BACKGROUND_REMOVAL_MAX_PIXELS) {
    return { code: "invalid-input", message: "The local background-removal PNG header exceeds the safe profile." };
  }
  try {
    const decoded = PNG.sync.read(Buffer.from(bytes));
    if (decoded.width !== width || decoded.height !== height) {
      return { code: "invalid-input", message: "The local background-removal image dimensions exceed the safe limit." };
    }
    return { width, height };
  } catch {
    return { code: "invalid-input", message: "The local background-removal PNG could not be decoded." };
  }
}

function defaultWorkerFactory(): BackgroundRemovalWorkerLike {
  return new Worker(new URL("./background-removal-worker.js", import.meta.url)) as unknown as BackgroundRemovalWorkerLike;
}

export class BackgroundRemovalQueue {
  #pending: QueueItem[] = [];
  #active = false;
  #closed = false;

  get activeCount(): number { return this.#active ? 1 : 0; }
  get pendingCount(): number { return this.#pending.length; }

  async remove(bytes: Uint8Array, options: BackgroundRemovalOptions = {}): Promise<BackgroundRemovalResult> {
    const original = new Uint8Array(bytes);
    const limits = parseBoundedPng(original, options.maxInputBytes ?? BACKGROUND_REMOVAL_MAX_INPUT_BYTES);
    if ("code" in limits) return resultFailure("failed", original, limits);
    if (this.#closed) return resultFailure("failed", original, { code: "worker-failed", message: "The local background-removal queue is closed." }, limits.width, limits.height);
    if (options.signal?.aborted) return resultFailure("cancelled", original, { code: "cancelled", message: "Local background removal was cancelled." }, limits.width, limits.height);

    return new Promise<BackgroundRemovalResult>((resolve) => {
      const item: QueueItem = { bytes: original, options, resolve, settled: false };
      this.#pending.push(item);
      const cancel = (): void => {
        if (item.settled) return;
        const index = this.#pending.indexOf(item);
        if (index >= 0) {
          this.#pending.splice(index, 1);
          item.settled = true;
          resolve(resultFailure("cancelled", original, { code: "cancelled", message: "Local background removal was cancelled." }, limits.width, limits.height));
        }
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      void this.#drain();
    });
  }

  close(): void {
    this.#closed = true;
    for (const item of this.#pending.splice(0)) {
      if (!item.settled) {
        item.settled = true;
        item.resolve(resultFailure("cancelled", item.bytes, { code: "cancelled", message: "Local background-removal queue closed." }));
      }
    }
  }

  async #drain(): Promise<void> {
    if (this.#active) return;
    const item = this.#pending.shift();
    if (item === undefined) return;
    if (item.settled) return this.#drain();
    this.#active = true;
    try {
      item.resolve(await this.#run(item));
    } finally {
      item.settled = true;
      this.#active = false;
      void this.#drain();
    }
  }

  async #run(item: QueueItem): Promise<BackgroundRemovalResult> {
    const parsed = parseBoundedPng(item.bytes, item.options.maxInputBytes ?? BACKGROUND_REMOVAL_MAX_INPUT_BYTES);
    if ("code" in parsed) return resultFailure("failed", item.bytes, parsed);
    const timeoutMs = item.options.timeoutMs ?? BACKGROUND_REMOVAL_DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      return resultFailure("failed", item.bytes, { code: "worker-failed", message: "The local background-removal timeout is invalid." }, parsed.width, parsed.height);
    }
    // The packaged plugin is a single self-contained ESM runtime. Running the
    // verified ONNX worker logic in this queue avoids a second unbundled worker
    // entrypoint while preserving serialized execution and all output gates.
    if (item.options.workerFactory === undefined) {
      return await this.#runLocally(item, parsed, timeoutMs);
    }
    let worker: BackgroundRemovalWorkerLike;
    try {
      worker = item.options.workerFactory?.() ?? defaultWorkerFactory();
    } catch {
      return resultFailure("failed", item.bytes, { code: "worker-failed", message: "The local background-removal worker could not start." }, parsed.width, parsed.height);
    }

    return new Promise<BackgroundRemovalResult>((resolve) => {
      let settled = false;
      const finish = (result: BackgroundRemovalResult): void => {
        if (settled) return;
        settled = true;
        if (item.options.signal !== undefined) item.options.signal.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        worker.removeListener?.("message", onMessage);
        worker.removeListener?.("error", onError);
        worker.removeListener?.("exit", onExit);
        void Promise.resolve(worker.terminate()).catch(() => undefined).finally(() => resolve(result));
      };
      const onAbort = (): void => finish(resultFailure("cancelled", item.bytes, { code: "cancelled", message: "Local background removal was cancelled." }, parsed.width, parsed.height));
      const onMessage = (response: BackgroundRemovalWorkerResponse): void => {
        if (response === null || typeof response !== "object" ||
            ((response as { readonly type?: unknown }).type !== "failure" &&
             (response as { readonly type?: unknown }).type !== "success")) {
          finish(resultFailure("failed", item.bytes, { code: "quality-gate-failed", message: "The local background-removal worker returned an invalid response." }, parsed.width, parsed.height));
          return;
        }
        if (response.type === "failure") {
          finish(resultFailure("failed", item.bytes, { code: response.code, message: response.message }, parsed.width, parsed.height));
          return;
        }
        if (!(response.bytes instanceof Uint8Array) || response.width !== parsed.width || response.height !== parsed.height) {
          finish(resultFailure("failed", item.bytes, { code: "quality-gate-failed", message: "The local background-removal worker returned mismatched output dimensions." }, parsed.width, parsed.height));
          return;
        }
        if (response.bytes.byteLength > (item.options.maxOutputBytes ?? BACKGROUND_REMOVAL_MAX_OUTPUT_BYTES)) {
          finish(resultFailure("failed", item.bytes, { code: "output-too-large", message: "The local background-removal output exceeds the byte limit." }, parsed.width, parsed.height));
          return;
        }
        const outputQuality = inspectPngAlpha(response.bytes, parsed.width, parsed.height);
        if ("code" in outputQuality) {
          finish(resultFailure("failed", item.bytes, outputQuality, parsed.width, parsed.height));
          return;
        }
        finish({ status: "succeeded", originalBytes: new Uint8Array(item.bytes), transparentBytes: new Uint8Array(response.bytes), width: response.width, height: response.height });
      };
      const onError = (): void => finish(resultFailure("failed", item.bytes, { code: "worker-crashed", message: "The local background-removal worker crashed." }, parsed.width, parsed.height));
      const onExit = (code: number): void => { if (!settled && code !== 0) onError(); };
      const timer = setTimeout(() => finish(resultFailure("failed", item.bytes, { code: "timeout", message: "Local background removal exceeded its deadline." }, parsed.width, parsed.height)), timeoutMs);
      worker.on("message", onMessage).on("error", onError).on("exit", onExit);
      item.options.signal?.addEventListener("abort", onAbort, { once: true });
      if (item.options.signal?.aborted) onAbort();
      else worker.postMessage({
        type: "process",
        bytes: item.bytes,
        ...(item.options.maxInputBytes === undefined ? {} : { maxInputBytes: item.options.maxInputBytes }),
        ...(item.options.maxOutputBytes === undefined ? {} : { maxOutputBytes: item.options.maxOutputBytes }),
        ...(item.options.mask === undefined ? {} : { mask: item.options.mask })
      });
    });
  }

  async #runLocally(
    item: QueueItem,
    parsed: { readonly width: number; readonly height: number },
    timeoutMs: number
  ): Promise<BackgroundRemovalResult> {
    if (item.options.signal?.aborted) {
      return resultFailure("cancelled", item.bytes, { code: "cancelled", message: "Local background removal was cancelled." }, parsed.width, parsed.height);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<BackgroundRemovalWorkerResponse>((resolve) => {
      timer = setTimeout(() => resolve({
        type: "failure",
        code: "timeout",
        message: "Local background removal exceeded its deadline."
      } as BackgroundRemovalWorkerResponse), timeoutMs);
    });
    const cancelled = new Promise<BackgroundRemovalWorkerResponse>((resolve) => {
      item.options.signal?.addEventListener("abort", () => resolve({
        type: "failure",
        code: "cancelled",
        message: "Local background removal was cancelled."
      } as BackgroundRemovalWorkerResponse), { once: true });
    });
    let response: BackgroundRemovalWorkerResponse;
    try {
      response = await Promise.race([
        processBackgroundRemovalRequest({
          type: "process",
          bytes: item.bytes,
          ...(item.options.maxInputBytes === undefined ? {} : { maxInputBytes: item.options.maxInputBytes }),
          ...(item.options.maxOutputBytes === undefined ? {} : { maxOutputBytes: item.options.maxOutputBytes }),
          ...(item.options.mask === undefined ? {} : { mask: item.options.mask })
        }),
        timeout,
        cancelled
      ]);
    } catch {
      return resultFailure("failed", item.bytes, { code: "worker-failed", message: "The local background-removal runtime failed." }, parsed.width, parsed.height);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (response.type === "failure") {
      const code = response.code;
      return resultFailure(code === "cancelled" ? "cancelled" : "failed", item.bytes, { code, message: response.message }, parsed.width, parsed.height);
    }
    if (!(response.bytes instanceof Uint8Array) || response.width !== parsed.width || response.height !== parsed.height) {
      return resultFailure("failed", item.bytes, { code: "quality-gate-failed", message: "The local background-removal runtime returned mismatched output dimensions." }, parsed.width, parsed.height);
    }
    if (response.bytes.byteLength > (item.options.maxOutputBytes ?? BACKGROUND_REMOVAL_MAX_OUTPUT_BYTES)) {
      return resultFailure("failed", item.bytes, { code: "output-too-large", message: "The local background-removal output exceeds the byte limit." }, parsed.width, parsed.height);
    }
    const outputQuality = inspectPngAlpha(response.bytes, parsed.width, parsed.height);
    if ("code" in outputQuality) return resultFailure("failed", item.bytes, outputQuality, parsed.width, parsed.height);
    return { status: "succeeded", originalBytes: new Uint8Array(item.bytes), transparentBytes: new Uint8Array(response.bytes), width: response.width, height: response.height };
  }
}

const defaultQueue = new BackgroundRemovalQueue();

export function createBackgroundRemovalQueue(): BackgroundRemovalQueue {
  return new BackgroundRemovalQueue();
}

export function removeBackground(
  bytes: Uint8Array,
  options: BackgroundRemovalOptions = {}
): Promise<BackgroundRemovalResult> {
  return defaultQueue.remove(bytes, options);
}
