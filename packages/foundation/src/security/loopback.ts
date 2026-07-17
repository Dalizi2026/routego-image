import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type LoopbackAddress = "127.0.0.1" | "::1";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);

export function assertLoopbackBindAddress(address: string): LoopbackAddress {
  if (address !== "127.0.0.1" && address !== "::1") {
    throw new Error("Local services may bind only to 127.0.0.1 or ::1");
  }
  return address;
}

export function generateSessionToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 24 || byteLength > 128) {
    throw new Error("Session tokens must contain between 24 and 128 random bytes");
  }
  return randomBytes(byteLength).toString("base64url");
}

export function constantTimeSessionTokenEqual(actual: string, expected: string): boolean {
  if (actual.length === 0 || expected.length === 0) {
    return false;
  }
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function normalizeLoopbackOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Allowed origins must be exact loopback HTTP(S) origins");
  }
  return parsed.origin;
}

export interface LoopbackRequestPolicyInput {
  readonly origin?: string;
  readonly allowedOrigins: readonly string[];
  readonly presentedToken?: string;
  readonly expectedToken: string;
  readonly cookieHeader?: string;
}

export type LoopbackRequestPolicyDecision =
  | { readonly allowed: true; readonly allowOrigin: string }
  | {
      readonly allowed: false;
      readonly code: "origin_rejected" | "session_invalid";
      readonly safeMessage: string;
    };

export function authorizeLoopbackRequest(
  input: LoopbackRequestPolicyInput
): LoopbackRequestPolicyDecision {
  if (input.cookieHeader !== undefined && input.cookieHeader.trim() !== "") {
    return {
      allowed: false,
      code: "origin_rejected",
      safeMessage: "Cookie authentication is not accepted by the local service."
    };
  }

  let normalizedOrigin: string;
  try {
    if (input.origin === undefined) {
      throw new Error("missing origin");
    }
    normalizedOrigin = normalizeLoopbackOrigin(input.origin);
    const allowedOrigins = input.allowedOrigins.map(normalizeLoopbackOrigin);
    if (!allowedOrigins.includes(normalizedOrigin)) {
      throw new Error("origin mismatch");
    }
  } catch {
    return {
      allowed: false,
      code: "origin_rejected",
      safeMessage: "The request origin is not allowed by the local service."
    };
  }

  if (
    input.presentedToken === undefined ||
    input.presentedToken.length === 0 ||
    input.expectedToken.length === 0 ||
    !constantTimeSessionTokenEqual(input.presentedToken, input.expectedToken)
  ) {
    return {
      allowed: false,
      code: "session_invalid",
      safeMessage: "The local session is missing or no longer valid."
    };
  }

  return { allowed: true, allowOrigin: normalizedOrigin };
}

export function createLoopbackCorsHeaders(origin: string): Readonly<Record<string, string>> {
  const normalized = normalizeLoopbackOrigin(origin);
  return {
    "access-control-allow-origin": normalized,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-routego-session",
    vary: "Origin"
  };
}
