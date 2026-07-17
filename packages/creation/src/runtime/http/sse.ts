import {
  studioImageOperationEventSchema,
  type StudioImageOperationEvent
} from "@routego-image/contracts";

import type { RoutegoHttpResponse } from "./types";

interface Channel {
  lastSequence: number;
  closed: boolean;
  readonly subscriptions: Set<EventSubscription>;
}

export interface StudioEventSubscriptionOptions {
  readonly signal?: AbortSignal;
  readonly onCancel?: () => void | Promise<void>;
}

class EventSubscription implements AsyncIterable<StudioImageOperationEvent> {
  readonly #queue: StudioImageOperationEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<StudioImageOperationEvent>) => void> = [];
  readonly #remove: () => void;
  readonly #onCancel: (() => void | Promise<void>) | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #abortListener: (() => void) | undefined;
  #closed = false;
  #cancelled = false;

  constructor(remove: () => void, options: StudioEventSubscriptionOptions) {
    this.#remove = remove;
    this.#onCancel = options.onCancel;
    this.#signal = options.signal;
    this.#abortListener = options.signal === undefined ? undefined : () => {
      void this.cancel();
    };
    if (this.#abortListener !== undefined && options.signal?.aborted !== true) {
      options.signal?.addEventListener("abort", this.#abortListener, { once: true });
    }
  }

  push(event: StudioImageOperationEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value: event });
    else this.#queue.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    while (this.#waiters.length > 0) this.#waiters.shift()?.({ done: true, value: undefined });
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#closed = true;
    this.#queue.length = 0;
    this.#cleanup();
    while (this.#waiters.length > 0) this.#waiters.shift()?.({ done: true, value: undefined });
    if (this.#onCancel !== undefined) {
      try {
        await this.#onCancel();
      } catch {
        // Cancellation callbacks cannot keep a stream subscribed.
      }
    }
  }

  #cleanup(): void {
    this.#remove();
    if (this.#signal !== undefined && this.#abortListener !== undefined) {
      this.#signal.removeEventListener("abort", this.#abortListener);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StudioImageOperationEvent> {
    return {
      next: async (): Promise<IteratorResult<StudioImageOperationEvent>> => {
        const event = this.#queue.shift();
        if (event !== undefined) return { done: false, value: event };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: async (): Promise<IteratorResult<StudioImageOperationEvent>> => {
        await this.cancel();
        return { done: true, value: undefined };
      }
    };
  }
}

export class StudioEventBroker {
  readonly #channels = new Map<string, Channel>();

  subscribe(
    requestId: string,
    options: StudioEventSubscriptionOptions = {}
  ): AsyncIterable<StudioImageOperationEvent> {
    if (requestId.trim() === "") throw new Error("requestId must not be empty");
    const channel = this.#channels.get(requestId) ?? {
      lastSequence: -1,
      closed: false,
      subscriptions: new Set<EventSubscription>()
    };
    this.#channels.set(requestId, channel);
    let subscription: EventSubscription;
    subscription = new EventSubscription(() => channel.subscriptions.delete(subscription), options);
    if (options.signal?.aborted === true) void subscription.cancel();
    else if (channel.closed) subscription.close();
    else channel.subscriptions.add(subscription);
    return subscription;
  }

  publish(value: unknown): StudioImageOperationEvent {
    const event = studioImageOperationEventSchema.parse(value);
    const channel = this.#channels.get(event.requestId) ?? {
      lastSequence: -1,
      closed: false,
      subscriptions: new Set<EventSubscription>()
    };
    this.#channels.set(event.requestId, channel);
    if (channel.closed) throw new Error("Cannot publish after a terminal Studio event");
    if (event.sequence <= channel.lastSequence) {
      throw new Error("Studio event sequences must increase monotonically");
    }
    channel.lastSequence = event.sequence;
    for (const subscription of channel.subscriptions) subscription.push(event);
    if (event.type === "completed" || event.type === "failed") {
      channel.closed = true;
      for (const subscription of [...channel.subscriptions]) subscription.close();
    }
    return event;
  }

  close(requestId: string): void {
    const channel = this.#channels.get(requestId);
    if (channel === undefined || channel.closed) return;
    channel.closed = true;
    for (const subscription of [...channel.subscriptions]) subscription.close();
  }

  closeAll(): void {
    for (const requestId of this.#channels.keys()) this.close(requestId);
  }
}

export function serializeStudioImageOperationEvent(value: unknown): string {
  const event = studioImageOperationEventSchema.parse(value);
  return `id: ${event.requestId}:${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createStudioEventStreamResponse(
  events: AsyncIterable<StudioImageOperationEvent>
): RoutegoHttpResponse {
  async function* body(): AsyncGenerator<string> {
    for await (const event of events) yield serializeStudioImageOperationEvent(event);
  }
  return {
    status: 200,
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    },
    body: body()
  };
}
