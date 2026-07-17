export interface ObjectUrlApi {
  createObjectURL(value: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface ProtectedObjectUrl {
  readonly url: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly revoked: boolean;
  revoke(): void;
}

export function createProtectedObjectUrl(
  blob: Blob,
  objectUrlApi: ObjectUrlApi = URL
): ProtectedObjectUrl {
  const url = objectUrlApi.createObjectURL(blob);
  let revoked = false;
  return {
    url,
    mimeType: blob.type,
    byteLength: blob.size,
    get revoked() {
      return revoked;
    },
    revoke() {
      if (!revoked) {
        revoked = true;
        objectUrlApi.revokeObjectURL(url);
      }
    }
  };
}
