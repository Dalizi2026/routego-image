export type StudioGatewayErrorCode =
  | "binary_upload_failed"
  | "http_error"
  | "invalid_input"
  | "invalid_output"
  | "network_error"
  | "session_missing"
  | "unsafe_resource";

export class StudioGatewayError extends Error {
  readonly code: StudioGatewayErrorCode;
  readonly status?: number;

  constructor(code: StudioGatewayErrorCode, message: string, status?: number) {
    super(message);
    this.name = "StudioGatewayError";
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}
