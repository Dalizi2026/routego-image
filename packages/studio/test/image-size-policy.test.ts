import { describe, expect, it } from "vitest";

import {
  normalizeCustomImageSize,
  sizeForTier,
  tierForSize
} from "../src/features/settings/image-size-policy";

describe("OpenAI-compatible Studio image size policy", () => {
  it("uses the compatible preset matrix instead of arbitrary edge multiplication", () => {
    expect(sizeForTier("2K", "16:9")).toBe("2560x1440");
    expect(sizeForTier("4K", "1:1")).toBe("2880x2880");
    expect(sizeForTier("4K", "21:9")).toBe("3840x1600");
    expect(tierForSize("3648x2052")).toBeUndefined();
  });

  it("persists a 16-aligned bounded custom size that is safe to send upstream", () => {
    expect(normalizeCustomImageSize("1920", "816")).toBe("1920x816");
    expect(normalizeCustomImageSize("3648", "2052")).toBe("3648x2048");
    expect(normalizeCustomImageSize("4096", "4096")).toBe("2880x2880");
    expect(normalizeCustomImageSize("0", "816")).toBeUndefined();
  });
});
