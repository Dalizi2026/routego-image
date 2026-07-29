import { createHash } from "node:crypto";

import {
  generationEndpointInputSchema,
  providerEndpointSetSchema,
  type EndpointInputMode,
  type GenerationEndpointInput,
  type ProviderEndpointSet
} from "@routego-image/contracts";

export interface NormalizedProviderEndpointSet {
  readonly mode: EndpointInputMode;
  readonly configuredGenerationValue: string;
  readonly generationEndpoint: string;
  readonly modelsEndpoint?: string;
  readonly editsEndpoint?: string;
  readonly responsesEndpoint?: string;
}

function serializeProviderUrl(value: string): string {
  return new URL(value).href;
}

export function normalizeGenerationEndpoint(input: GenerationEndpointInput): string {
  const parsed = generationEndpointInputSchema.parse(input);
  const endpoint = new URL(parsed.value);

  if (parsed.mode === "exact-generation-endpoint") {
    return endpoint.href;
  }

  let pathname = endpoint.pathname.replace(/\/+$/u, "");
  if (pathname === "") {
    pathname = "/";
  }

  if (!pathname.endsWith("/images/generations")) {
    pathname = pathname.endsWith("/v1")
      ? `${pathname}/images/generations`
      : `${pathname === "/" ? "" : pathname}/v1/images/generations`;
  }

  endpoint.pathname = pathname;
  return endpoint.href;
}

export function deriveImagesEditsEndpoint(generationEndpoint: string): string {
  const endpoint = new URL(generationEndpoint);
  if (!endpoint.pathname.endsWith("/images/generations")) {
    throw new Error("The normalized generation endpoint cannot derive an Images Edits endpoint.");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/generations$/u, "/edits");
  return endpoint.href;
}

export function normalizeProviderEndpoints(input: ProviderEndpointSet): NormalizedProviderEndpointSet {
  const parsed = providerEndpointSetSchema.parse(input);
  const normalized: NormalizedProviderEndpointSet = {
    mode: parsed.generation.mode,
    configuredGenerationValue: parsed.generation.value,
    generationEndpoint: normalizeGenerationEndpoint(parsed.generation)
  };

  return {
    ...normalized,
    ...(parsed.models === undefined ? {} : { modelsEndpoint: serializeProviderUrl(parsed.models) }),
    ...(parsed.edits === undefined ? {} : { editsEndpoint: serializeProviderUrl(parsed.edits) }),
    ...(parsed.responses === undefined
      ? {}
      : { responsesEndpoint: serializeProviderUrl(parsed.responses) })
  };
}

export function fingerprintProviderEndpoint(endpoint: string): string {
  return createHash("sha256").update(serializeProviderUrl(endpoint), "utf8").digest("hex");
}
