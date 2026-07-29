import { describe, expect, it } from "vitest";

import { imageOperationRequestSchema } from "@routego-image/contracts";
import { PROVIDER_REQUEST_SHAPES, type SelectedProviderRoute } from "@routego-image/foundation";
import { planEffectiveProviderControls, serializeTierBRequest } from "../src/provider/requests";

const route: SelectedProviderRoute = {
  selected: true,
  tier: "B",
  transport: "openai-images",
  endpoint: "https://relay.example.invalid/v1/images/generations",
  requestShape: PROVIDER_REQUEST_SHAPES.imagesGenerationsJson,
  effectiveKind: "generate",
  requiredCapabilities: ["custom-size"],
  degraded: false,
  replayPolicy: "never-cross-transport"
};

describe("OpenAI-compatible image generation requests", () => {
  it("keeps the saved PNG and auto controls explicit for compatibility relays", () => {
    const request = imageOperationRequestSchema.parse({
      kind: "generate",
      prompt: "Compatibility request",
      size: "1920x816",
      aspectRatio: "auto",
      quality: "auto",
      format: "png",
      moderation: "auto",
      count: 1
    });
    const effective = planEffectiveProviderControls(request, route);
    const submission = serializeTierBRequest("gpt-image-2", request, route, { images: [], totalBytes: 0 }, effective);

    expect(submission.body).toMatchObject({
      model: "gpt-image-2",
      prompt: "Compatibility request",
      size: "1920x816",
      quality: "auto",
      output_format: "png",
      moderation: "auto"
    });
    expect(submission.body).not.toHaveProperty("n");
  });
});
