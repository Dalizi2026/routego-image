import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  BackgroundRemovalQueue,
  type BackgroundRemovalWorkerLike
} from "../src/runtime/background-removal";
import {
  compositeMask,
  inspectPngAlpha,
  validateMaskQuality
} from "../src/runtime/background-removal-worker";

function pngBytes(width = 2, height = 2): Uint8Array {
  const png = new PNG({ width, height });
  png.data.fill(220);
  for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  return new Uint8Array(PNG.sync.write(png, { colorType: 6, inputColorType: 6, inputHasAlpha: true }));
}

class FakeWorker implements BackgroundRemovalWorkerLike {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  terminated = false;
  constructor(private readonly behavior: "success" | "crash" | "hang" | "invalid-output", private readonly delayMs = 0) {}
  on(event: string, listener: (...args: any[]) => void): this { const set = this.listeners.get(event) ?? new Set(); set.add(listener); this.listeners.set(event, set); return this; }
  once(event: string, listener: (...args: any[]) => void): this { const wrapped = (...args: any[]) => { this.removeListener(event, wrapped); listener(...args); }; return this.on(event, wrapped); }
  removeListener(event: string, listener: (...args: any[]) => void): this { this.listeners.get(event)?.delete(listener); return this; }
  emit(event: string, ...args: any[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  postMessage(): void {
    if (this.behavior === "hang") return;
    setTimeout(() => {
      if (this.terminated) return;
      if (this.behavior === "crash") this.emit("exit", 1);
      else this.emit("message", {
        type: "success",
        bytes: this.behavior === "invalid-output"
          ? pngBytes()
          : compositeMask(new Uint8Array([220, 220, 220, 255, 220, 220, 220, 255, 220, 220, 220, 255, 220, 220, 220, 255]), 2, 2, Uint8Array.of(255, 0, 255, 0)),
        width: 2,
        height: 2
      });
    }, this.delayMs);
  }
  terminate(): number { this.terminated = true; return 0; }
}

describe("local background-removal worker lifecycle", () => {
  it("runs queued requests serially and preserves each original", async () => {
    const queue = new BackgroundRemovalQueue();
    let active = 0;
    let maximum = 0;
    const factory = (): BackgroundRemovalWorkerLike => {
      active += 1;
      maximum = Math.max(maximum, active);
      const worker = new FakeWorker("success", 5);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { active -= 1; return terminate(); };
      return worker;
    };
    const original = pngBytes();
    const [first, second] = await Promise.all([
      queue.remove(original, { workerFactory: factory, mask: Uint8Array.of(255, 0, 255, 0) }),
      queue.remove(original, { workerFactory: factory, mask: Uint8Array.of(255, 0, 255, 0) })
    ]);
    expect(maximum).toBe(1);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(Buffer.from(first.originalBytes)).toEqual(Buffer.from(original));
  });

  it("terminates a crashed worker and keeps the original", async () => {
    const original = pngBytes();
    const worker = new FakeWorker("crash");
    const result = await new BackgroundRemovalQueue().remove(original, { workerFactory: () => worker, timeoutMs: 100 });
    expect(result.status).toBe("failed");
    if (result.status === "succeeded") throw new Error("unexpected success");
    expect(result.error.code).toBe("worker-crashed");
    expect(worker.terminated).toBe(true);
    expect(Buffer.from(result.originalBytes)).toEqual(Buffer.from(original));
  });

  it("terminates on timeout and cancellation without replay", async () => {
    const original = pngBytes();
    const timeoutWorker = new FakeWorker("hang");
    const timedOut = await new BackgroundRemovalQueue().remove(original, { workerFactory: () => timeoutWorker, timeoutMs: 5 });
    expect(timedOut.status).toBe("failed");
    if (timedOut.status === "succeeded") throw new Error("unexpected success");
    expect(timedOut.error.code).toBe("timeout");
    expect(timeoutWorker.terminated).toBe(true);

    const controller = new AbortController();
    const cancelledWorker = new FakeWorker("hang");
    const pending = new BackgroundRemovalQueue().remove(original, { workerFactory: () => cancelledWorker, signal: controller.signal, timeoutMs: 100 });
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelledWorker.terminated).toBe(true);
  });

  it("rejects empty, full, mismatched, non-finite, and boundary-anomalous masks", () => {
    expect(validateMaskQuality(Uint8Array.of(0, 0, 0, 0), 2, 2)).toMatchObject({ code: "quality-gate-failed" });
    expect(validateMaskQuality(Uint8Array.of(255, 255, 255, 255), 2, 2)).toMatchObject({ code: "quality-gate-failed" });
    expect(validateMaskQuality(Uint8Array.of(255, 0, 255), 2, 2)).toMatchObject({ code: "quality-gate-failed" });
    expect(validateMaskQuality(new Float32Array([Number.NaN, 0, 1, 0]), 2, 2)).toMatchObject({ code: "quality-gate-failed" });
    expect(validateMaskQuality(Uint8Array.of(255, 255, 255, 255, 255, 255, 255, 255, 255, 0), 3, 3)).toMatchObject({ code: "quality-gate-failed" });

    const plausible = validateMaskQuality(new Float32Array([1, 0, 1, 0]), 2, 2);
    expect(plausible).toEqual(Uint8Array.of(255, 0, 255, 0));
    expect(validateMaskQuality(Uint8Array.of(0, 0, 0, 0, 255, 0, 0, 0, 0), 3, 3)).toEqual(
      Uint8Array.of(0, 0, 0, 0, 255, 0, 0, 0, 0)
    );
  });

  it("revalidates output alpha and preserves the original on a quality failure", async () => {
    const original = pngBytes();
    const invalidOutputWorker = new FakeWorker("invalid-output");
    const result = await new BackgroundRemovalQueue().remove(original, {
      workerFactory: () => invalidOutputWorker,
      timeoutMs: 100,
      mask: Uint8Array.of(255, 0, 255, 0)
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "quality-gate-failed" } });
    if (result.status === "succeeded") throw new Error("unexpected success");
    expect(Buffer.from(result.originalBytes)).toEqual(Buffer.from(original));
    expect(inspectPngAlpha(pngBytes(), 2, 2)).toMatchObject({ code: "quality-gate-failed" });
  });
});
