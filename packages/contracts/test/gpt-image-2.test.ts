import { describe, expect, it } from "vitest";

import {
  gptImage2SizeViolation,
  isGptImage2Model
} from "../src/gpt-image-2";

describe("GPT Image 2 size contract", () => {
  it("identifies only the exact GPT Image 2 model identifier", () => {
    expect(isGptImage2Model("gpt-image-2")).toBe(true);
    expect(isGptImage2Model(" GPT-IMAGE-2 ")).toBe(true);
    expect(isGptImage2Model("gpt-image-2-preview")).toBe(false);
  });

  it("accepts official maximum presets and rejects the former 4096 square preset", () => {
    expect(gptImage2SizeViolation("2880x2880")).toBeUndefined();
    expect(gptImage2SizeViolation("3840x2160")).toBeUndefined();
    expect(gptImage2SizeViolation("2160x3840")).toBeUndefined();
    expect(gptImage2SizeViolation("4096x4096")).toContain("3840 px");
  });
});
