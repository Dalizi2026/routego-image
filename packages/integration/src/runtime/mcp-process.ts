import { homedir } from "node:os";
import path from "node:path";

import {
  createRoutegoMcpServer,
  type RoutegoMcpServer
} from "@routego-image/creation";
import type { RoutegoService } from "@routego-image/contracts";
import {
  REDACTED_BINARY_DATA,
  REDACTED_IMAGE_DATA,
  redactDiagnostic,
  type LoopbackAddress
} from "@routego-image/foundation";
import {
  createRoutegoLibraryService,
  type RoutegoLibraryService
} from "@routego-image/library";

import {
  ProductionLocalRoutegoService,
  type LocalRoutegoServiceOptions
} from "../composition/service";
import {
  createEphemeralImageResourceRegistry,
  type EphemeralImageResourceRegistry
} from "./ephemeral-resources";
import {
  IntegrationLoopbackHttpHost,
  type IntegrationLoopbackHttpHostOptions
} from "./http-host";
import {
  IntegrationHttpLifecycle,
  type RuntimeSignalSource
} from "./lifecycle";
import {
  createIntegrationRuntimeRoutes,
  StudioRequestSessionContext,
  type IntegrationRuntimeRouteOptions
} from "./routes";
import {
  StudioSessionManager,
  type StudioSessionManagerOptions
} from "./sessions";
import {
  loadStudioStaticAssets,
  type StudioStaticAssetOptions
} from "./static";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const REDACTED_LOCAL_PATH = "[REDACTED_PATH]";
const IMAGE_DATA_URL_PATTERN =
  /data:image\/[a-z0-9][a-z0-9.+-]*(?:;[a-z0-9!#$&^_.+-]+=(?:"[^"\r\n]*"|[^;,\s]*))*(?:;base64)?,(?:(?:%[0-9a-f]{2})|[a-z0-9+/_~.!$&*=@?:-])*/giu;
const LONG_BASE64_TOKEN_PATTERN =
  /(^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{64,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/gu;

export interface RoutegoMcpInput extends AsyncIterable<Uint8Array | string> {
  destroy?(error?: Error): unknown;
}

export interface RoutegoMcpOutput {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "drain", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

export interface ManagedRoutegoService extends RoutegoService {
  recover(): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedRoutegoHttpLifecycle {
  shutdown(): Promise<void>;
}

export type RoutegoProcessDiagnosticSink = (diagnostic: unknown) => void | Promise<void>;

interface RoutegoMcpProcessConstructionOptions {
  readonly service: ManagedRoutegoService;
  readonly httpLifecycle: ManagedRoutegoHttpLifecycle;
  readonly input: RoutegoMcpInput;
  readonly output: RoutegoMcpOutput;
  readonly signalSource: RuntimeSignalSource;
  readonly diagnose: RoutegoProcessDiagnosticSink;
  readonly maximumLineBytes?: number;
  readonly shutdownTimeoutMs?: number;
  /**
   * Some Windows MCP hosts close STDIO immediately after a tool response even
   * while an authenticated Studio page is still using the loopback listener.
   * Keep the HTTP/service lifecycle alive in that case; signals still perform
   * the normal bounded shutdown.
   */
  readonly retainHttpOnMcpDisconnect?: boolean;
}

export interface CreateRoutegoMcpProcessOptions {
  readonly service: ManagedRoutegoService;
  readonly httpLifecycle: ManagedRoutegoHttpLifecycle;
  readonly input?: RoutegoMcpInput;
  readonly output?: RoutegoMcpOutput;
  readonly error?: RoutegoMcpOutput;
  readonly signalSource?: RuntimeSignalSource;
  readonly logger?: RoutegoProcessDiagnosticSink;
  readonly maximumLineBytes?: number;
  readonly shutdownTimeoutMs?: number;
  readonly retainHttpOnMcpDisconnect?: boolean;
}

type ServiceOverrides = Omit<
  LocalRoutegoServiceOptions,
  "library" | "stagingRoot" | "ephemeralResources" | "studioSession" | "openStudio"
>;

type HostOverrides = Omit<
  IntegrationLoopbackHttpHostOptions,
  | "service"
  | "localService"
  | "address"
  | "staticAssets"
  | "entryModuleRoute"
  | "styleRoutes"
  | "sessions"
  | "sessionOptions"
  | "extensionHandler"
  | "logger"
>;

type RouteOverrides = Omit<
  IntegrationRuntimeRouteOptions,
  "service" | "library" | "ephemeralResources" | "sessions" | "sessionContext"
>;

export interface ProductionRoutegoMcpProcessOptions {
  readonly staticAssets: StudioStaticAssetOptions;
  readonly entryModuleRoute: string;
  readonly styleRoutes?: readonly string[];
  readonly homeDirectory?: string;
  /**
   * Optional private root for the settings, credentials, uploads, and Library.
   * Platform-specific plugin packages use this to keep their local state isolated.
   */
  readonly dataRoot?: string;
  readonly runtimeRoot?: string;
  readonly stagingRoot?: string;
  readonly library?: RoutegoLibraryService;
  readonly ephemeralResources?: EphemeralImageResourceRegistry;
  readonly serviceOptions?: ServiceOverrides;
  readonly hostOptions?: HostOverrides;
  readonly routeOptions?: RouteOverrides;
  readonly sessionOptions?: StudioSessionManagerOptions;
  readonly input?: RoutegoMcpInput;
  readonly output?: RoutegoMcpOutput;
  readonly error?: RoutegoMcpOutput;
  readonly signalSource?: RuntimeSignalSource;
  readonly logger?: RoutegoProcessDiagnosticSink;
  readonly maximumLineBytes?: number;
  readonly shutdownTimeoutMs?: number;
  /** Windows-only compatibility mode for hosts that close MCP STDIO after opening Studio. */
  readonly retainHttpOnMcpDisconnect?: boolean;
}

/**
 * Every MCP runtime gets its own staging subtree by default. Studio and
 * conversational MCP processes can coexist, and their startup recovery must
 * never delete a live operation owned by another process.
 */
export function resolveProductionStagingRoot(
  runtimeRoot: string,
  configuredStagingRoot: string | undefined,
  processId = process.pid
): string {
  if (configuredStagingRoot !== undefined) return path.resolve(configuredStagingRoot);
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new TypeError("The Routego Image runtime process identifier is invalid.");
  }
  return path.resolve(runtimeRoot, "staging", `process-${processId}`);
}

export class RoutegoMcpProcessShutdownError extends Error {
  readonly code: "shutdown-failed" | "shutdown-timeout";

  constructor(code: RoutegoMcpProcessShutdownError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RoutegoMcpProcessShutdownError";
    this.code = code;
  }
}

function isNumericByteArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  );
}

function redactDiagnosticString(value: string): string {
  const withoutImageData = value
    .replace(IMAGE_DATA_URL_PATTERN, REDACTED_IMAGE_DATA)
    .replace(
      LONG_BASE64_TOKEN_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED_IMAGE_DATA}`
    );
  const withoutWebUrls = withoutImageData.replace(/https?:\/\/[^\s<>"']+/giu, "");
  return /[\\/]/u.test(withoutWebUrls) ? REDACTED_LOCAL_PATH : withoutImageData;
}

function redactProcessDiagnostic(value: unknown): unknown {
  const redacted = redactDiagnostic(value);
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactDiagnosticString(current);
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) return REDACTED_BINARY_DATA;
    if (Array.isArray(current)) {
      if (isNumericByteArray(current)) return REDACTED_BINARY_DATA;
      return current.map(visit);
    }
    if (current === null || typeof current !== "object") return current;
    if (current instanceof Date) return new Date(current.getTime());
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      output[key] = visit(child);
    }
    return output;
  };
  return visit(redacted);
}

function diagnosticLine(value: unknown): string {
  try {
    return `${JSON.stringify(
      redactProcessDiagnostic(value),
      (_key, child: unknown) => typeof child === "bigint" ? child.toString() : child
    )}\n`;
  } catch {
    return '{"name":"DiagnosticSerializationError","message":"[REDACTED]"}\n';
  }
}

async function writeWithBackpressure(output: RoutegoMcpOutput, chunk: string): Promise<void> {
  if (output.destroyed === true || output.writableEnded === true) {
    throw new Error("The output channel is closed.");
  }
  if (output.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("close", onClose);
      output.off("error", onError);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onDrain = () => settle();
    const onClose = () => settle(new Error("The output channel closed before it drained."));
    const onError = (error: Error) => settle(error);
    output.once("drain", onDrain);
    output.once("close", onClose);
    output.once("error", onError);
    if (output.destroyed === true || output.writableEnded === true) onClose();
  });
}

function createDiagnosticReporter(
  errorOutput: RoutegoMcpOutput,
  observer?: RoutegoProcessDiagnosticSink
): RoutegoProcessDiagnosticSink {
  return async (diagnostic: unknown) => {
    const safe = redactProcessDiagnostic(diagnostic);
    try {
      await writeWithBackpressure(errorOutput, diagnosticLine(safe));
    } catch {
      // A broken diagnostic channel cannot corrupt stdout or block cleanup.
    }
    if (observer !== undefined) {
      try {
        await observer(safe);
      } catch {
        // Diagnostic observers cannot affect protocol or lifecycle behavior.
      }
    }
  };
}

function positiveTimeout(value: number | undefined): number {
  const selected = value ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 120_000) {
    throw new TypeError("shutdownTimeoutMs must be an integer from 1 through 120000");
  }
  return selected;
}

async function withTimeout(operation: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RoutegoMcpProcessShutdownError(
        "shutdown-timeout",
        "The Routego Image process exceeded its bounded shutdown deadline."
      ));
    }, milliseconds);
    timer.unref?.();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function cleanupFailure(results: readonly PromiseSettledResult<void>[]): Error | undefined {
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 0) return undefined;
  return new RoutegoMcpProcessShutdownError(
    "shutdown-failed",
    "One or more Routego Image runtime components failed to close safely.",
    { cause: new AggregateError(failures) }
  );
}

/** Owns raw STDIO framing and coordinates MCP, HTTP, service, and signal lifecycle. */
export class RoutegoMcpProcess {
  readonly #options: RoutegoMcpProcessConstructionOptions;
  readonly #server: RoutegoMcpServer;
  readonly #shutdownTimeoutMs: number;
  readonly #signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  readonly #closedPromise: Promise<void>;
  readonly #resolveClosed: () => void;
  #startPromise: Promise<void> | undefined;
  #inputTask: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #shutdownError: unknown;
  #closing = false;
  #closed = false;

  constructor(options: RoutegoMcpProcessConstructionOptions) {
    this.#options = options;
    this.#shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs);
    let resolveClosed: (() => void) | undefined;
    this.#closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = () => resolveClosed?.();
    this.#server = createRoutegoMcpServer({
      service: options.service,
      write: async (line) => await writeWithBackpressure(options.output, line),
      logger: options.diagnose,
      ...(options.maximumLineBytes === undefined
        ? {}
        : { maximumLineBytes: options.maximumLineBytes })
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get shutdownError(): unknown {
    return this.#shutdownError;
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    if (this.#closing || this.#closed) throw new Error("The Routego Image process is closed.");
    try {
      await this.#options.service.recover();
      if (this.#closing || this.#closed) return;
      this.#installSignalHandlers();
      this.#inputTask = this.#consumeInput();
      void this.#inputTask.catch(() => undefined);
    } catch (error) {
      await this.#options.diagnose({ code: "runtime_start_failed", error });
      await this.shutdown("startup-failed").catch(() => undefined);
      throw error;
    }
  }

  async run(): Promise<void> {
    await this.start();
    await this.waitUntilClosed();
    if (this.#shutdownError !== undefined) throw this.#shutdownError;
  }

  async waitUntilClosed(): Promise<void> {
    await this.#closedPromise;
  }

  async #consumeInput(): Promise<void> {
    try {
      for await (const chunk of this.#options.input) {
        if (this.#closing) return;
        await this.#server.handleChunk(chunk);
        if (this.#server.closed) {
          if (this.#options.retainHttpOnMcpDisconnect === true) return;
          await this.shutdown("mcp-shutdown");
          return;
        }
      }
      if (this.#closing) return;
      await this.#server.finish();
      if (this.#options.retainHttpOnMcpDisconnect === true) {
        // The MCP transport is no longer usable, but the authenticated Studio
        // page must keep its same-process loopback API until the host signals
        // termination. This mode is enabled only by the Windows launcher.
        this.#server.shutdown();
        return;
      }
      await this.shutdown(this.#server.closed ? "mcp-shutdown" : "stdin-eof");
    } catch (error) {
      if (!this.#closing) {
        await this.#options.diagnose({ code: "stdio_input_failed", error });
        await this.shutdown("stdin-error").catch(() => undefined);
      }
    }
  }

  #installSignalHandlers(): void {
    if (this.#signalHandlers.size > 0) return;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        void this.shutdown(signal).catch(() => undefined);
      };
      this.#signalHandlers.set(signal, handler);
      this.#options.signalSource.on(signal, handler);
    }
  }

  #removeSignalHandlers(): void {
    for (const [signal, handler] of this.#signalHandlers) {
      this.#options.signalSource.off(signal, handler);
    }
    this.#signalHandlers.clear();
  }

  shutdown(reason = "requested"): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown(reason);
    return this.#shutdownPromise;
  }

  async #shutdown(reason: string): Promise<void> {
    this.#closing = true;
    this.#removeSignalHandlers();
    this.#server.shutdown();
    if (reason !== "stdin-eof") {
      try {
        this.#options.input.destroy?.();
      } catch (error) {
        await this.#options.diagnose({ code: "stdio_input_close_failed", error });
      }
    }

    try {
      const cleanup = Promise.allSettled([
        this.#options.httpLifecycle.shutdown(),
        this.#options.service.close()
      ]).then((results) => {
        const failure = cleanupFailure(results);
        if (failure !== undefined) throw failure;
      });
      await withTimeout(cleanup, this.#shutdownTimeoutMs);
    } catch (error) {
      this.#shutdownError = error;
      await this.#options.diagnose({ code: "runtime_shutdown_failed", reason, error });
      throw error;
    } finally {
      this.#closed = true;
      this.#resolveClosed();
    }
  }
}

function processInput(input: RoutegoMcpInput | undefined): RoutegoMcpInput {
  return input ?? process.stdin as unknown as RoutegoMcpInput;
}

function processOutput(output: RoutegoMcpOutput | undefined): RoutegoMcpOutput {
  return output ?? process.stdout as unknown as RoutegoMcpOutput;
}

function processError(output: RoutegoMcpOutput | undefined): RoutegoMcpOutput {
  return output ?? process.stderr as unknown as RoutegoMcpOutput;
}

function processSignals(source: RuntimeSignalSource | undefined): RuntimeSignalSource {
  return source ?? process;
}

export function createRoutegoMcpProcess(options: CreateRoutegoMcpProcessOptions): RoutegoMcpProcess {
  const error = processError(options.error);
  return new RoutegoMcpProcess({
    service: options.service,
    httpLifecycle: options.httpLifecycle,
    input: processInput(options.input),
    output: processOutput(options.output),
    signalSource: processSignals(options.signalSource),
    diagnose: createDiagnosticReporter(error, options.logger),
    ...(options.maximumLineBytes === undefined
      ? {}
      : { maximumLineBytes: options.maximumLineBytes }),
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    ...(options.retainHttpOnMcpDisconnect === undefined
      ? {}
      : { retainHttpOnMcpDisconnect: options.retainHttpOnMcpDisconnect })
  });
}

export async function createProductionRoutegoMcpProcess(
  options: ProductionRoutegoMcpProcessOptions
): Promise<RoutegoMcpProcess> {
  const input = processInput(options.input);
  const output = processOutput(options.output);
  const error = processError(options.error);
  const signalSource = processSignals(options.signalSource);
  const diagnose = createDiagnosticReporter(error, options.logger);
  const selectedHome = path.resolve(options.homeDirectory ?? homedir());
  const runtimeRoot = path.resolve(
    options.runtimeRoot ?? path.join(selectedHome, ".codex", "routego-image", "runtime")
  );
  const stagingRoot = resolveProductionStagingRoot(runtimeRoot, options.stagingRoot);
  const dataRoot = options.dataRoot === undefined ? undefined : path.resolve(options.dataRoot);
  const library = options.library ?? createRoutegoLibraryService({
    homeDirectory: selectedHome,
    ...(dataRoot === undefined
      ? {}
      : {
          settings: { dataRoot },
          uploads: { dataRoot },
          index: { root: path.join(dataRoot, "library") }
        })
  });
  const ownsEphemeralResources = options.ephemeralResources === undefined;
  const ephemeralResources = options.ephemeralResources ??
    await createEphemeralImageResourceRegistry({ root: path.join(runtimeRoot, "ephemeral") });

  try {
    const staticAssets = await loadStudioStaticAssets(options.staticAssets);
    const sessionContext = new StudioRequestSessionContext();
    let service: ProductionLocalRoutegoService | undefined;
    const lifecycle = new IntegrationHttpLifecycle({
      logger: diagnose,
      createHost: (address: LoopbackAddress) => {
        const activeService = service;
        if (activeService === undefined) {
          throw new Error("The production local service is not initialized.");
        }
        const sessions = new StudioSessionManager(options.sessionOptions);
        const extensionHandler = createIntegrationRuntimeRoutes({
          service: activeService,
          library,
          ephemeralResources,
          sessions,
          sessionContext,
          ...options.routeOptions
        });
        return new IntegrationLoopbackHttpHost({
          service: activeService,
          localService: activeService,
          address,
          staticAssets,
          entryModuleRoute: options.entryModuleRoute,
          sessions,
          extensionHandler,
          logger: diagnose,
          ...(options.styleRoutes === undefined ? {} : { styleRoutes: options.styleRoutes }),
          ...options.hostOptions
        });
      }
    });
    service = new ProductionLocalRoutegoService({
      library,
      stagingRoot,
      ephemeralResources,
      studioSession: () => lifecycle.studioSession(),
      openStudio: async (request) => await lifecycle.openStudio(request),
      serviceHealth: () => ({
        status: "ready",
        version: "1.0.5",
        nodeVersion: process.version,
        uptimeSeconds: 0,
        mcpAvailable: true,
        httpAvailable: lifecycle.host?.isHealthy === true,
        studioAvailable: lifecycle.host?.isHealthy === true
      }),
      ...options.serviceOptions
    });
    return new RoutegoMcpProcess({
      service,
      httpLifecycle: lifecycle,
      input,
      output,
      signalSource,
      diagnose,
      ...(options.maximumLineBytes === undefined
        ? {}
        : { maximumLineBytes: options.maximumLineBytes }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      ...(options.retainHttpOnMcpDisconnect === undefined
        ? {}
        : { retainHttpOnMcpDisconnect: options.retainHttpOnMcpDisconnect })
    });
  } catch (error) {
    if (ownsEphemeralResources) await ephemeralResources.shutdown().catch(() => 0);
    await diagnose({ code: "runtime_composition_failed", error });
    throw error;
  }
}
