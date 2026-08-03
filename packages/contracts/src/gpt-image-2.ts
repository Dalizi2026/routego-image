/**
 * GPT Image 2 accepts flexible dimensions, but only within this exact raster
 * envelope. Keeping the constants in Contracts makes Studio and the runtime
 * enforce the same request boundary.
 */
export const GPT_IMAGE_2_SIZE_LIMITS = Object.freeze({
  multiple: 16,
  maxEdge: 3_840,
  maxPixels: 8_294_400,
  minPixels: 655_360,
  maxAspectRatio: 3
});

export function isGptImage2Model(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === "gpt-image-2";
}

/**
 * Returns a safe, user-facing reason when an exact GPT Image 2 size cannot be
 * sent as requested. `auto` remains a valid provider-controlled choice.
 */
export function gptImage2SizeViolation(size: string): string | undefined {
  if (size === "auto") return undefined;
  const match = /^(\d+)x(\d+)$/u.exec(size);
  if (match === null) return "GPT Image 2 requires an exact WIDTHxHEIGHT size or auto.";

  const width = Number(match[1]);
  const height = Number(match[2]);
  const { multiple, maxEdge, maxPixels, minPixels, maxAspectRatio } = GPT_IMAGE_2_SIZE_LIMITS;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < multiple ||
    height < multiple ||
    width % multiple !== 0 ||
    height % multiple !== 0 ||
    Math.max(width, height) > maxEdge ||
    width * height > maxPixels ||
    width * height < minPixels ||
    width / height > maxAspectRatio ||
    height / width > maxAspectRatio
  ) {
    return "GPT Image 2 requires dimensions aligned to 16 px, with each edge at most 3840 px, at most 8,294,400 total pixels, and an aspect ratio no wider than 3:1.";
  }
  return undefined;
}
