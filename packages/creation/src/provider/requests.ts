import {
  imageOperationRequestSchema,
  routegoServiceErrorSchema,
  type ImageOperationRequest,
  type ProviderCapability,
  type RoutegoServiceError
} from "@routego-image/contracts";
import {
  PROVIDER_REQUEST_SHAPES,
  REDACTED_BINARY_DATA,
  redactDiagnostic,
  selectProviderRoute,
  type SelectedProviderRoute
} from "@routego-image/foundation";

import { imageDataUrl, prepareImageInputs } from "./image-inputs";
import {
  ProviderPreparationError,
  type EffectiveProviderControls,
  type EffectiveProviderPlan,
  type PrepareImageInputOptions,
  type PreparedImageInputs,
  type PreparedProviderRequest,
  type ProviderJsonObject,
  type ProviderJsonSubmission,
  type ProviderRequestPreparationContext,
  type ProviderRequestPreparationResult,
  type ProviderSubmission
} from "./types";

function validationError(
  safeMessage: string,
  details: Readonly<Record<string, unknown>>
): RoutegoServiceError {
  return routegoServiceErrorSchema.parse({
    code: "invalid_input",
    category: "validation",
    stage: "validate",
    safeMessage,
    retryDisposition: "never",
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false,
    details: redactDiagnostic(details) as Record<string, unknown>
  });
}

function requiredControlCapabilities(request: ImageOperationRequest): ProviderCapability[] {
  const required: ProviderCapability[] = [];
  if (request.count > 1) required.push("native-variants");
  if (request.size !== "auto" || request.aspectRatio !== "auto") required.push("custom-size");
  if (request.quality !== "auto") required.push("quality-control");
  if (request.format !== "png") required.push("output-format");
  if (request.compression !== undefined) required.push("compression");
  if (request.partialImages > 0) required.push("streaming", "partial-images");
  if (request.transparentMode === "native") required.push("native-transparency");
  if (request.moderation === "low") required.push("moderation");
  return [...new Set(required)];
}

export function planEffectiveProviderControls(
  requestInput: ImageOperationRequest,
  route: SelectedProviderRoute
): EffectiveProviderPlan {
  const request = imageOperationRequestSchema.parse(requestInput);
  const missing = requiredControlCapabilities(request).filter(
    (capability) => !route.requiredCapabilities.includes(capability)
  );
  if (missing.length > 0) {
    throw new ProviderPreparationError(
      "request-shape-mismatch",
      "The selected route does not authorize every requested provider control.",
      { missingCapabilities: missing }
    );
  }

  const size = request.size !== "auto"
    ? request.size
    : request.aspectRatio !== "auto"
      ? request.aspectRatio
      : "auto";
  const controls: EffectiveProviderControls = {
    n: request.count,
    size,
    nativeTransparency: request.transparentMode === "native",
    stream: request.partialImages > 0,
    ...(request.quality === "auto" ? {} : { quality: request.quality }),
    ...(request.format === "png" ? {} : { outputFormat: request.format }),
    ...(request.compression === undefined
      ? {}
      : { outputCompression: request.compression }),
    ...(request.partialImages === 0 ? {} : { partialImages: request.partialImages }),
    ...(request.moderation === "auto" ? {} : { moderation: request.moderation })
  };

  return {
    effectiveParams: request,
    controls,
    degraded: route.degraded
  };
}

function jsonSubmission(endpoint: string, body: ProviderJsonObject): ProviderJsonSubmission {
  return {
    bodyType: "json",
    method: "POST",
    endpoint,
    headers: { "content-type": "application/json" },
    body
  };
}

function commonJsonFields(
  model: string,
  request: ImageOperationRequest,
  controls: EffectiveProviderControls
): ProviderJsonObject {
  return {
    model,
    prompt: request.prompt,
    n: controls.n,
    size: controls.size,
    ...(controls.quality === undefined ? {} : { quality: controls.quality }),
    ...(controls.outputFormat === undefined ? {} : { output_format: controls.outputFormat }),
    ...(controls.outputCompression === undefined
      ? {}
      : { output_compression: controls.outputCompression }),
    ...(controls.partialImages === undefined ? {} : { partial_images: controls.partialImages }),
    ...(controls.nativeTransparency ? { background: "transparent" } : {}),
    ...(controls.moderation === undefined ? {} : { moderation: controls.moderation }),
    ...(controls.stream ? { stream: true } : {})
  };
}

function assertTierRoute(
  route: SelectedProviderRoute,
  expectedTier: SelectedProviderRoute["tier"],
  expectedTransport: SelectedProviderRoute["transport"]
): void {
  if (route.tier !== expectedTier || route.transport !== expectedTransport) {
    throw new ProviderPreparationError(
      "request-shape-mismatch",
      "The selected provider route does not match the requested serializer.",
      {
        selectedTier: route.tier,
        selectedTransport: route.transport,
        expectedTier,
        expectedTransport
      }
    );
  }
}

export function serializeTierARequest(
  model: string,
  request: ImageOperationRequest,
  route: SelectedProviderRoute,
  inputs: PreparedImageInputs,
  effective: EffectiveProviderPlan
): ProviderJsonSubmission {
  assertTierRoute(route, "A", "single-endpoint-json");
  const body: ProviderJsonObject = commonJsonFields(model, request, effective.controls);
  if (route.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointText) {
    if (inputs.images.length !== 0) {
      throw new ProviderPreparationError(
        "request-shape-mismatch",
        "A text-only provider route cannot contain image inputs."
      );
    }
    return jsonSubmission(route.endpoint, body);
  }
  if (route.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImage) {
    const image = inputs.images[0];
    if (inputs.images.length !== 1 || image === undefined) {
      throw new ProviderPreparationError(
        "request-shape-mismatch",
        "The selected single-image route requires exactly one prepared image."
      );
    }
    return jsonSubmission(route.endpoint, {
      ...body,
      image: imageDataUrl(image)
    });
  }
  if (route.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImages) {
    if (inputs.images.length < 2) {
      throw new ProviderPreparationError(
        "request-shape-mismatch",
        "The selected multiple-image route requires at least two prepared images."
      );
    }
    return jsonSubmission(route.endpoint, {
      ...body,
      images: inputs.images.map(imageDataUrl)
    });
  }
  throw new ProviderPreparationError(
    "request-shape-mismatch",
    "The selected Tier A request shape is not supported.",
    { requestShape: route.requestShape }
  );
}

export function serializeTierBRequest(
  model: string,
  request: ImageOperationRequest,
  route: SelectedProviderRoute,
  inputs: PreparedImageInputs,
  effective: EffectiveProviderPlan
): ProviderSubmission {
  assertTierRoute(route, "B", "openai-images");
  if (route.requestShape !== PROVIDER_REQUEST_SHAPES.imagesGenerationsJson) {
    throw new ProviderPreparationError(
      "request-shape-mismatch",
      "The selected Tier B request shape is not supported.",
      { requestShape: route.requestShape }
    );
  }
  if (inputs.images.length !== 0) {
    throw new ProviderPreparationError(
      "request-shape-mismatch",
      "Images generations JSON cannot contain prepared image inputs."
    );
  }
  return jsonSubmission(route.endpoint, commonJsonFields(model, request, effective.controls));
}

export function serializeTierCRequest(
  model: string,
  request: ImageOperationRequest,
  route: SelectedProviderRoute,
  inputs: PreparedImageInputs,
  effective: EffectiveProviderPlan
): ProviderJsonSubmission {
  assertTierRoute(route, "C", "openai-responses");
  if (route.requestShape !== PROVIDER_REQUEST_SHAPES.responsesImageGeneration) {
    throw new ProviderPreparationError(
      "request-shape-mismatch",
      "The selected Tier C request shape is not supported.",
      { requestShape: route.requestShape }
    );
  }

  const content: ProviderJsonObject[] = [
    { type: "input_text", text: request.prompt },
    ...inputs.images.map((image) => ({ type: "input_image", image_url: imageDataUrl(image) }))
  ];
  const tool: ProviderJsonObject = {
    type: "image_generation",
    ...(effective.controls.n === 1 ? {} : { n: effective.controls.n }),
    ...(effective.controls.size === "auto" ? {} : { size: effective.controls.size }),
    ...(effective.controls.quality === undefined
      ? {}
      : { quality: effective.controls.quality }),
    ...(effective.controls.outputFormat === undefined
      ? {}
      : { output_format: effective.controls.outputFormat }),
    ...(effective.controls.outputCompression === undefined
      ? {}
      : { output_compression: effective.controls.outputCompression }),
    ...(effective.controls.partialImages === undefined
      ? {}
      : { partial_images: effective.controls.partialImages }),
    ...(effective.controls.nativeTransparency ? { background: "transparent" } : {}),
    ...(effective.controls.moderation === undefined
      ? {}
      : { moderation: effective.controls.moderation })
  };
  return jsonSubmission(route.endpoint, {
    model,
    input: [{ role: "user", content }],
    tools: [tool],
    ...(effective.controls.stream ? { stream: true } : {})
  });
}

export function serializeProviderRequest(
  model: string,
  request: ImageOperationRequest,
  route: SelectedProviderRoute,
  inputs: PreparedImageInputs,
  effective: EffectiveProviderPlan
): ProviderSubmission {
  switch (route.tier) {
    case "A":
      return serializeTierARequest(model, request, route, inputs, effective);
    case "B":
      return serializeTierBRequest(model, request, route, inputs, effective);
    case "C":
      return serializeTierCRequest(model, request, route, inputs, effective);
  }
}

export async function prepareProviderRequest(
  context: ProviderRequestPreparationContext,
  requestInput: unknown,
  inputOptions: PrepareImageInputOptions = {}
): Promise<ProviderRequestPreparationResult> {
  const parsed = imageOperationRequestSchema.safeParse(requestInput);
  if (!parsed.success) {
    return {
      prepared: false,
      error: validationError("The image operation request is invalid.", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message
        }))
      })
    };
  }

  let route;
  try {
    route = selectProviderRoute(context, parsed.data);
  } catch {
    return {
      prepared: false,
      error: validationError("The provider routing context is invalid.", {
        reason: "invalid-routing-context"
      })
    };
  }
  if (!route.selected) {
    return { prepared: false, route, error: route.error };
  }

  try {
    const inputs = await prepareImageInputs(parsed.data, inputOptions);
    const effective = planEffectiveProviderControls(parsed.data, route);
    const submission = serializeProviderRequest(
      context.model,
      parsed.data,
      route,
      inputs,
      effective
    );
    const value: PreparedProviderRequest = {
      route,
      requestedParams: parsed.data,
      effective,
      inputs,
      submission
    };
    return { prepared: true, value };
  } catch (error) {
    if (error instanceof ProviderPreparationError) {
      return {
        prepared: false,
        route,
        error: validationError(error.message, { reason: error.reason, ...error.details })
      };
    }
    return {
      prepared: false,
      route,
      error: validationError("The provider request could not be prepared safely.", {
        reason: "unexpected-preparation-failure"
      })
    };
  }
}

export function redactProviderDiagnostic(value: unknown): unknown {
  return redactDiagnostic(value);
}

export function describePreparedProviderRequest(request: PreparedProviderRequest): unknown {
  const body = request.submission.bodyType === "json"
    ? request.submission.body
    : {
        type: "multipart",
        entries: [...request.submission.body.entries()].map(([name, value]) => ({
          name,
          value: typeof value === "string"
            ? value
            : {
                type: "file",
                mimeType: value.type,
                byteLength: value.size,
                content: REDACTED_BINARY_DATA
              }
        }))
      };
  return redactDiagnostic({
    method: request.submission.method,
    endpoint: request.submission.endpoint,
    headers: request.submission.headers,
    body
  });
}
