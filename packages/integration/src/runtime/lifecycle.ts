import {
  routegoOpenStudioInputSchema,
  type RoutegoOpenStudioInput,
  type RoutegoOpenStudioResult
} from "@routego-image/contracts";
import { assertLoopbackBindAddress, redactDiagnostic, type LoopbackAddress } from "@routego-image/foundation";

import type { IssuedStudioLaunch } from "./http-host";
import type { StudioSessionDescriptor } from "./sessions";

export interface ManagedIntegrationHttpHost {
  readonly address: { readonly address: LoopbackAddress } | undefined;
  readonly isHealthy: boolean;
  readonly sessions: {
    getSession(id: string): StudioSessionDescriptor | undefined;
  };
  openStudioSession(reused?: boolean): Promise<IssuedStudioLaunch>;
  close(): Promise<void>;
}

export interface RuntimeSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface IntegrationHttpLifecycleOptions {
  readonly createHost: (
    address: LoopbackAddress
  ) => ManagedIntegrationHttpHost | Promise<ManagedIntegrationHttpHost>;
  readonly logger?: (diagnostic: unknown) => void | Promise<void>;
}

export interface ActiveStudioSessionContext {
  readonly id: string;
  readonly expiresAt: string;
}

type SignalName = "SIGINT" | "SIGTERM";

/** Serializes listener replacement, session issuance, and bounded shutdown. */
export class IntegrationHttpLifecycle {
  readonly #options: IntegrationHttpLifecycleOptions;
  #host: ManagedIntegrationHttpHost | undefined;
  #latestSessionId: string | undefined;
  #operation: Promise<void> = Promise.resolve();
  #shutdownPromise: Promise<void> | undefined;
  #shuttingDown = false;
  #closed = false;
  #signalSource: RuntimeSignalSource | undefined;
  #signalHandlers = new Map<SignalName, () => void>();

  constructor(options: IntegrationHttpLifecycleOptions) {
    this.#options = options;
  }

  get host(): ManagedIntegrationHttpHost | undefined {
    return this.#host;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async openStudio(input: RoutegoOpenStudioInput): Promise<RoutegoOpenStudioResult> {
    const parsed = routegoOpenStudioInputSchema.parse(input);
    if (this.#shuttingDown || this.#closed) {
      throw new Error("The local HTTP lifecycle is shutting down.");
    }
    return this.#enqueue(async () => {
      if (this.#shuttingDown || this.#closed) {
        throw new Error("The local HTTP lifecycle is shutting down.");
      }
      const address = assertLoopbackBindAddress(parsed.address);
      const reusable =
        parsed.reuseExisting &&
        this.#host?.isHealthy === true &&
        this.#host.address?.address === address;
      if (reusable) {
        const launch = await this.#host!.openStudioSession(true);
        this.#latestSessionId = launch.session.id;
        return launch.result;
      }

      const previous = this.#host;
      this.#host = undefined;
      this.#latestSessionId = undefined;
      if (previous !== undefined) await previous.close();

      const host = await this.#options.createHost(address);
      this.#host = host;
      try {
        const launch = await host.openStudioSession(false);
        this.#latestSessionId = launch.session.id;
        return launch.result;
      } catch (error) {
        this.#host = undefined;
        try {
          await host.close();
        } catch (closeError) {
          await this.#diagnose(closeError);
        }
        throw error;
      }
    });
  }

  studioSession(): ActiveStudioSessionContext {
    const id = this.#latestSessionId;
    const session = id === undefined ? undefined : this.#host?.sessions.getSession(id);
    if (session === undefined) throw new Error("No active Studio session is available.");
    return { id: session.id, expiresAt: session.expiresAt };
  }

  installSignalHandlers(source: RuntimeSignalSource = process): void {
    if (this.#signalSource !== undefined) {
      if (this.#signalSource === source) return;
      throw new Error("Signal handlers are already installed on another source.");
    }
    this.#signalSource = source;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        void this.shutdown().catch((error: unknown) => this.#diagnose(error));
      };
      this.#signalHandlers.set(signal, handler);
      source.on(signal, handler);
    }
  }

  removeSignalHandlers(): void {
    const source = this.#signalSource;
    if (source === undefined) return;
    for (const [signal, handler] of this.#signalHandlers) source.off(signal, handler);
    this.#signalHandlers.clear();
    this.#signalSource = undefined;
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.removeSignalHandlers();
    this.#shutdownPromise = this.#enqueue(async () => {
      const host = this.#host;
      this.#host = undefined;
      this.#latestSessionId = undefined;
      try {
        if (host !== undefined) await host.close();
      } catch (error) {
        await this.#diagnose(error);
        throw error;
      } finally {
        this.#closed = true;
      }
    });
    return this.#shutdownPromise;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #diagnose(value: unknown): Promise<void> {
    if (this.#options.logger === undefined) return;
    try {
      await this.#options.logger(redactDiagnostic(value));
    } catch {
      // Diagnostic sinks cannot affect shutdown.
    }
  }
}

export function createIntegrationHttpLifecycle(
  options: IntegrationHttpLifecycleOptions
): IntegrationHttpLifecycle {
  return new IntegrationHttpLifecycle(options);
}
