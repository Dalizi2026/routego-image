export type MaskCloseDisposition = "close" | "confirm-discard";

export function maskCloseDisposition(hasUnsavedChanges: boolean): MaskCloseDisposition {
  return hasUnsavedChanges ? "confirm-discard" : "close";
}
