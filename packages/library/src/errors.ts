export type LibraryErrorCode =
  | "access_denied"
  | "auth_failed"
  | "cancelled"
  | "capability_unavailable"
  | "config_corrupt"
  | "config_missing"
  | "conflict"
  | "download_failed"
  | "file_write_failed"
  | "internal_contract"
  | "invalid_input"
  | "invalid_request"
  | "invalid_response"
  | "lock_timeout"
  | "moderation_blocked"
  | "not_found"
  | "origin_rejected"
  | "path_unsafe"
  | "postprocess_failed"
  | "provider_5xx"
  | "rate_limited"
  | "session_invalid"
  | "timeout"
  | "upload_checksum_failed"
  | "upload_consumed"
  | "upload_discarded"
  | "upload_expired"
  | "upload_invalid_type"
  | "upload_oversize"
  | "unsupported_version";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(
    code: LibraryErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, string | number | boolean>>;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LibraryError";
    this.code = code;
    this.details = options.details;
  }
}

export function isNodeError(value: unknown, code?: string): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof (value as NodeJS.ErrnoException).code === "string" &&
    (code === undefined || (value as NodeJS.ErrnoException).code === code)
  );
}
