import {
  generationEndpointInputSchema,
  redactedEndpointDescriptorSchema,
  type EndpointInputMode
} from "@routego-image/contracts";

export function describeProviderEndpoint(value: string, mode: EndpointInputMode) {
  const input = generationEndpointInputSchema.parse({ value, mode });
  const parsed = new URL(input.value);
  const hasQuery = parsed.search.length > 0;
  const hasFragment = parsed.hash.length > 0;
  const display = `${parsed.origin}${parsed.pathname}${hasQuery ? "?[REDACTED]" : ""}${
    hasFragment ? "#[REDACTED]" : ""
  }`;

  return redactedEndpointDescriptorSchema.parse({
    mode: input.mode,
    origin: parsed.origin,
    pathname: parsed.pathname || "/",
    hasQuery,
    display
  });
}

export function redactUrlForDiagnostics(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[REDACTED]" : ""}${
      parsed.hash ? "#[REDACTED]" : ""
    }`;
  } catch {
    return "[INVALID_URL_REDACTED]";
  }
}
