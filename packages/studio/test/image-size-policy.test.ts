import { describe, expect, it } from "vitest";

import {
  normalizeCustomAspectRatio,
  normalizeCustomImageSize,
  ratioForImageSize,
  sizeForTier,
  suggestedTierForSize,
  tierForSize
} from "../src/features/settings/image-size-policy";

describe("OpenAI-compatible Studio image size policy", () => {
  it("uses the compatible preset matrix instead of arbitrary edge multiplication", () => {
    expect(sizeForTier("2K", "16:9")).toBe("2560x1440");
    expect(sizeForTier("4K", "1:1")).toBe("4096x4096");
    expect(sizeForTier("4K", "21:9")).toBe("4096x1760");
    expect(tierForSize("3648x2052")).toBeUndefined();
  });

  it("persists a 16-aligned bounded custom size that is safe to send upstream", () => {
    expect(normalizeCustomImageSize("1920", "816")).toBe("1920x816");
    expect(normalizeCustomImageSize("3648", "2052")).toBe("3648x2048");
    expect(normalizeCustomImageSize("4096", "4096")).toBe("4096x4096");
    expect(normalizeCustomImageSize("0", "816")).toBeUndefined();
  });

  it("calculates bounded concrete sizes for a custom ratio at every resolution tier", () => {
    expect(normalizeCustomAspectRatio("10 : 8")).toBe("5:4");
    expect(normalizeCustomAspectRatio("7:2")).toBeUndefined();
    expect(sizeForTier("1K", "5:4")).toBe("1024x816");
    expect(sizeForTier("2K", "5:4")).toBe("2048x1632");
    expect(sizeForTier("4K", "5:4")).toBe("4096x3280");
  });

  it("keeps older custom dimensions editable through an inferred ratio and tier", () => {
    expect(ratioForImageSize("1920x816")).toBe("40:17");
    expect(suggestedTierForSize("1920x816")).toBe("2K");
    expect(suggestedTierForSize("auto")).toBe("auto");
  });
});
