import { createHash } from "node:crypto";

import { PNG } from "pngjs";

export interface SyntheticProbePng {
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly dataUrl: string;
}

export type SyntheticProbePngKind = "image" | "mask";

const SYNTHETIC_PROBE_SIZE = 4;

export function createDeterministicSyntheticPng(
  kind: SyntheticProbePngKind = "image"
): SyntheticProbePng {
  const png = new PNG({ width: SYNTHETIC_PROBE_SIZE, height: SYNTHETIC_PROBE_SIZE });
  for (let y = 0; y < SYNTHETIC_PROBE_SIZE; y += 1) {
    for (let x = 0; x < SYNTHETIC_PROBE_SIZE; x += 1) {
      const offset = (y * SYNTHETIC_PROBE_SIZE + x) * 4;
      const active = (x + y) % 2 === 0;
      if (kind === "mask") {
        png.data[offset] = 255;
        png.data[offset + 1] = 255;
        png.data[offset + 2] = 255;
        png.data[offset + 3] = active ? 255 : 0;
      } else {
        png.data[offset] = active ? 32 : 224;
        png.data[offset + 1] = active ? 96 : 192;
        png.data[offset + 2] = active ? 224 : 48;
        png.data[offset + 3] = 255;
      }
    }
  }
  const bytes = PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
    bitDepth: 8,
    deflateLevel: 9,
    deflateStrategy: 3,
    filterType: 4
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    mimeType: "image/png",
    width: SYNTHETIC_PROBE_SIZE,
    height: SYNTHETIC_PROBE_SIZE,
    byteLength: bytes.byteLength,
    sha256,
    bytes: new Uint8Array(bytes),
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
  };
}

export function createDeterministicSyntheticPngInputs(): {
  readonly image: SyntheticProbePng;
  readonly mask: SyntheticProbePng;
} {
  return {
    image: createDeterministicSyntheticPng("image"),
    mask: createDeterministicSyntheticPng("mask")
  };
}
