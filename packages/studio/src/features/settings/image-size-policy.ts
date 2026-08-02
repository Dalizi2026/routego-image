const SIZE_MULTIPLE = 16;
const MAX_EDGE = 3840;
const MAX_ASPECT_RATIO = 3;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;

export const resolutionTiers = ["auto", "1K", "2K", "4K"] as const;
export const configurableRatios = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"] as const;

export type ResolutionTier = (typeof resolutionTiers)[number];
export type ConfigurableRatio = (typeof configurableRatios)[number];

const sizePresets: Record<Exclude<ResolutionTier, "auto">, Record<ConfigurableRatio, string>> = {
  "1K": {
    "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "4:3": "1024x768",
    "3:4": "768x1024", "16:9": "1280x720", "9:16": "720x1280", "21:9": "1280x544"
  },
  "2K": {
    "1:1": "2048x2048", "3:2": "2160x1440", "2:3": "1440x2160", "4:3": "2048x1536",
    "3:4": "1536x2048", "16:9": "2560x1440", "9:16": "1440x2560", "21:9": "2560x1088"
  },
  "4K": {
    "1:1": "2880x2880", "3:2": "3456x2304", "2:3": "2304x3456", "4:3": "3200x2400",
    "3:4": "2400x3200", "16:9": "3840x2160", "9:16": "2160x3840", "21:9": "3840x1600"
  }
};

function roundToMultiple(value: number): number {
  return Math.max(SIZE_MULTIPLE, Math.round(value / SIZE_MULTIPLE) * SIZE_MULTIPLE);
}

function floorToMultiple(value: number): number {
  return Math.max(SIZE_MULTIPLE, Math.floor(value / SIZE_MULTIPLE) * SIZE_MULTIPLE);
}

function ceilToMultiple(value: number): number {
  return Math.max(SIZE_MULTIPLE, Math.ceil(value / SIZE_MULTIPLE) * SIZE_MULTIPLE);
}

/**
 * Normalizes a calculated size using the limits accepted by the OpenAI-compatible
 * image routes used by the supported providers. The returned value is the exact
 * value persisted and sent upstream.
 */
export function normalizeCustomImageSize(widthText: string, heightText: string): string | undefined {
  const width = Number(widthText);
  const height = Number(heightText);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;

  let normalizedWidth = roundToMultiple(width);
  let normalizedHeight = roundToMultiple(height);
  const scaleToFit = (scale: number) => {
    normalizedWidth = floorToMultiple(normalizedWidth * scale);
    normalizedHeight = floorToMultiple(normalizedHeight * scale);
  };
  const scaleToFill = (scale: number) => {
    normalizedWidth = ceilToMultiple(normalizedWidth * scale);
    normalizedHeight = ceilToMultiple(normalizedHeight * scale);
  };

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const largestEdge = Math.max(normalizedWidth, normalizedHeight);
    if (largestEdge > MAX_EDGE) scaleToFit(MAX_EDGE / largestEdge);
    if (normalizedWidth / normalizedHeight > MAX_ASPECT_RATIO) {
      normalizedWidth = floorToMultiple(normalizedHeight * MAX_ASPECT_RATIO);
    } else if (normalizedHeight / normalizedWidth > MAX_ASPECT_RATIO) {
      normalizedHeight = floorToMultiple(normalizedWidth * MAX_ASPECT_RATIO);
    }
    const pixels = normalizedWidth * normalizedHeight;
    if (pixels > MAX_PIXELS) scaleToFit(Math.sqrt(MAX_PIXELS / pixels));
    else if (pixels < MIN_PIXELS) scaleToFill(Math.sqrt(MIN_PIXELS / pixels));
  }

  return `${normalizedWidth}x${normalizedHeight}`;
}

export function normalizedRatio(value: string): ConfigurableRatio {
  return configurableRatios.includes(value as ConfigurableRatio) ? value as ConfigurableRatio : "1:1";
}

function greatestCommonDivisor(left: number, right: number): number {
  let dividend = left;
  let divisor = right;
  while (divisor !== 0) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend;
}

/**
 * Converts user-entered W:H text into Routego's canonical aspect-ratio form.
 * Custom ratios follow the same 3:1 bounds as arbitrary provider dimensions.
 */
export function normalizeCustomAspectRatio(value: string): string | undefined {
  const match = /^\s*([1-9]\d{0,4})\s*:\s*([1-9]\d{0,4})\s*$/u.exec(value);
  if (match === null) return undefined;

  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = greatestCommonDivisor(width, height);
  const normalizedWidth = width / divisor;
  const normalizedHeight = height / divisor;
  if (
    normalizedWidth > 999 ||
    normalizedHeight > 999 ||
    normalizedWidth / normalizedHeight > MAX_ASPECT_RATIO ||
    normalizedHeight / normalizedWidth > MAX_ASPECT_RATIO
  ) {
    return undefined;
  }

  return `${normalizedWidth}:${normalizedHeight}`;
}

/**
 * Derives a concise W:H ratio from a saved dimension string. This keeps older
 * custom-dimension defaults editable after moving the UI to aspect ratios.
 */
export function ratioForImageSize(size: string): string | undefined {
  const match = /^(\d+)x(\d+)$/u.exec(size);
  if (match === null) return undefined;
  return normalizeCustomAspectRatio(`${match[1]}:${match[2]}`);
}

export function suggestedTierForSize(size: string): ResolutionTier {
  const match = /^(\d+)x(\d+)$/u.exec(size);
  if (match === null) return "auto";
  const longestEdge = Math.max(Number(match[1]), Number(match[2]));
  if (longestEdge <= 1_536) return "1K";
  if (longestEdge <= 2_560) return "2K";
  return "4K";
}

function sizeForCustomRatio(tier: Exclude<ResolutionTier, "auto">, ratio: string): string {
  const normalized = normalizeCustomAspectRatio(ratio);
  if (normalized === undefined) return sizePresets[tier]["1:1"];

  const [widthRatio, heightRatio] = normalized.split(":").map(Number) as [number, number];
  const largestEdge = tier === "1K" ? 1_024 : tier === "2K" ? 2_048 : 3_840;
  const width = widthRatio >= heightRatio ? largestEdge : largestEdge * (widthRatio / heightRatio);
  const height = widthRatio >= heightRatio ? largestEdge * (heightRatio / widthRatio) : largestEdge;
  return normalizeCustomImageSize(String(Math.round(width)), String(Math.round(height))) ?? sizePresets[tier]["1:1"];
}

export function sizeForTier(tier: ResolutionTier, ratio: string): string {
  if (tier === "auto") return "auto";
  return configurableRatios.includes(ratio as ConfigurableRatio)
    ? sizePresets[tier][ratio as ConfigurableRatio]
    : sizeForCustomRatio(tier, ratio);
}

export function tierForSize(size: string): ResolutionTier | undefined {
  for (const tier of resolutionTiers) {
    if (tier !== "auto" && configurableRatios.some((ratio) => sizePresets[tier][ratio] === size)) return tier;
  }
  return size === "auto" ? "auto" : undefined;
}
