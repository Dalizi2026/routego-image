export interface ResultDownloadPolicyInput {
  readonly resourceUrl: string;
  readonly providerEndpoint: string;
  readonly explicitSameOriginAuthorization?: boolean;
  readonly redirectFromUrl?: string;
}

export type ResultDownloadPolicyDecision =
  | {
      readonly allowed: true;
      readonly forwardAuthorization: boolean;
      readonly revalidateTarget: true;
      readonly reason:
        | "authorization-disabled"
        | "same-origin-explicit-policy"
        | "cross-origin-resource"
        | "redirect-origin-changed"
        | "redirect-same-origin";
    }
  | {
      readonly allowed: false;
      readonly forwardAuthorization: false;
      readonly revalidateTarget: true;
      readonly reason:
        | "invalid-url"
        | "unsupported-protocol"
        | "unsafe-cleartext-http"
        | "url-userinfo";
    };

function parseSafeDownloadUrl(value: string): URL | ResultDownloadPolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      allowed: false,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "invalid-url"
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      allowed: false,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "unsupported-protocol"
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      allowed: false,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "url-userinfo"
    };
  }
  if (
    parsed.protocol === "http:" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "[::1]" &&
    parsed.hostname !== "::1"
  ) {
    return {
      allowed: false,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "unsafe-cleartext-http"
    };
  }
  return parsed;
}

export function decideResultDownloadPolicy(
  input: ResultDownloadPolicyInput
): ResultDownloadPolicyDecision {
  const resource = parseSafeDownloadUrl(input.resourceUrl);
  if (!(resource instanceof URL)) {
    return resource;
  }
  const provider = parseSafeDownloadUrl(input.providerEndpoint);
  if (!(provider instanceof URL)) {
    return provider;
  }

  const explicit = input.explicitSameOriginAuthorization === true;
  const sameProviderOrigin = resource.origin === provider.origin;
  if (input.redirectFromUrl !== undefined) {
    const previous = parseSafeDownloadUrl(input.redirectFromUrl);
    if (!(previous instanceof URL)) {
      return previous;
    }
    if (previous.origin !== resource.origin) {
      return {
        allowed: true,
        forwardAuthorization: false,
        revalidateTarget: true,
        reason: "redirect-origin-changed"
      };
    }
    return {
      allowed: true,
      forwardAuthorization: explicit && sameProviderOrigin && previous.origin === provider.origin,
      revalidateTarget: true,
      reason:
        explicit && sameProviderOrigin && previous.origin === provider.origin
          ? "redirect-same-origin"
          : "authorization-disabled"
    };
  }

  if (!explicit) {
    return {
      allowed: true,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "authorization-disabled"
    };
  }
  if (!sameProviderOrigin) {
    return {
      allowed: true,
      forwardAuthorization: false,
      revalidateTarget: true,
      reason: "cross-origin-resource"
    };
  }
  return {
    allowed: true,
    forwardAuthorization: true,
    revalidateTarget: true,
    reason: "same-origin-explicit-policy"
  };
}
