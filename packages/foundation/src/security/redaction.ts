import { redactUrlForDiagnostics } from "./endpoints";

export const REDACTED_VALUE = "[REDACTED]" as const;
export const REDACTED_IMAGE_DATA = "[REDACTED_IMAGE_DATA]" as const;
export const REDACTED_BINARY_DATA = "[REDACTED_BINARY_DATA]" as const;
export const REDACTED_CIRCULAR_REFERENCE = "[CIRCULAR]" as const;

const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "password",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "setcookie",
  "token",
  "xapikey",
  "xroutegosession"
]);

const IMAGE_DATA_KEYS = new Set([
  "b64json",
  "base64",
  "dataurl",
  "imagebytes",
  "imagedata",
  "imagedataurl"
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function looksLikeImageData(value: unknown): boolean {
  if (typeof value === "string") {
    return /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(looksLikeImageData);
  }
  return false;
}

function sanitizeUrlMatches(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/giu, (match) => {
    const trailing = match.match(/[),.;!?]+$/u)?.[0] ?? "";
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    return `${redactUrlForDiagnostics(candidate)}${trailing}`;
  });
}

export function redactFreeText(value: string): string {
  return sanitizeUrlMatches(value)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu, REDACTED_IMAGE_DATA)
    .replace(
      /\b(x[-_ ]?routego[-_ ]?session|x[-_ ]?api[-_ ]?key|set[-_ ]?cookie|cookie|proxy[-_ ]?authorization|authorization)\s*[:=：＝]\s*[^\r\n,;；，。！？]*/giu,
      (_match, label: string) => `${label}: ${REDACTED_VALUE}`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED_VALUE}`)
    .replace(
      /\b(x[-_ ]?routego[-_ ]?session|x[-_ ]?api[-_ ]?key|api[-_ ]?key|proxy[-_ ]?authorization|authorization|set[-_ ]?cookie|cookie|session[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|bearer[-_ ]?token|client[-_ ]?secret|token|password|secret)\s*[:=：＝]\s*[^\s,;；，。！？]+/giu,
      (_match, label: string) => `${label}=${REDACTED_VALUE}`
    );
}

function redactInternal(value: unknown, key: string | undefined, seen: WeakMap<object, unknown>): unknown {
  const keyName = key === undefined ? "" : normalizedKey(key);
  if (SENSITIVE_KEYS.has(keyName)) {
    return REDACTED_VALUE;
  }
  if (IMAGE_DATA_KEYS.has(keyName) || ((keyName === "image" || keyName === "images") && looksLikeImageData(value))) {
    return REDACTED_IMAGE_DATA;
  }
  if (typeof value === "string") {
    return redactFreeText(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return REDACTED_BINARY_DATA;
  }
  if (value instanceof URL) {
    return redactUrlForDiagnostics(value.href);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactFreeText(value.message),
      ...(value.stack === undefined ? {} : { stack: redactFreeText(value.stack) })
    };
  }

  const objectValue = value as object;
  const existing = seen.get(objectValue);
  if (existing !== undefined) {
    return REDACTED_CIRCULAR_REFERENCE;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(objectValue, output);
    for (const item of value) {
      output.push(redactInternal(item, undefined, seen));
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(objectValue, output);
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    output[childKey] = redactInternal(childValue, childKey, seen);
  }
  return output;
}

export function redactDiagnostic(value: unknown): unknown {
  return redactInternal(value, undefined, new WeakMap());
}
