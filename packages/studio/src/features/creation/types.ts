import type {
  ReadSettingsResult,
  StudioImageInputRef,
  StudioImageOperationResult,
  UploadResourcePurpose
} from "@routego-image/contracts";

export type CreationMode = "generate" | "edit";

export type UploadLifecycleStatus =
  | "queued"
  | "reserving"
  | "uploading"
  | "finalizing"
  | "ready"
  | "failed"
  | "expired"
  | "discarding"
  | "discarded";

export interface UploadSource {
  readonly name: string;
  readonly blob: Blob;
}

export interface UploadLifecycleItem {
  readonly id: string;
  readonly purpose: UploadResourcePurpose;
  readonly source: UploadSource;
  readonly status: UploadLifecycleStatus;
  readonly uploadResourceId?: string | undefined;
  readonly safeMessage?: string | undefined;
}

export interface DraftImageInput {
  readonly id: string;
  readonly role:
    | "reference"
    | "style"
    | "composition"
    | "subject"
    | "character"
    | "product"
    | "background"
    | "layout"
    | "color-palette"
    | "supporting"
    | "previous-output";
  readonly label?: string | undefined;
  readonly locator?: StudioImageInputRef | undefined;
  readonly upload?: UploadLifecycleItem | undefined;
}

export interface CreationControls {
  readonly size: ReadSettingsResult["defaults"]["size"];
  readonly aspectRatio: ReadSettingsResult["defaults"]["aspectRatio"];
  readonly quality: ReadSettingsResult["defaults"]["quality"];
  readonly format: ReadSettingsResult["defaults"]["format"];
  readonly compression?: number | undefined;
  readonly count: ReadSettingsResult["defaults"]["count"];
  readonly partialImages: ReadSettingsResult["defaults"]["partialImages"];
  readonly transparentMode: ReadSettingsResult["defaults"]["transparentMode"];
  readonly moderation: ReadSettingsResult["defaults"]["moderation"];
  readonly saveToLibrary: boolean;
}

export interface EditInvariantsDraft {
  readonly allowedChanges: readonly string[];
  readonly preserve: readonly string[];
  readonly forbiddenChanges: readonly string[];
}

export interface CreationDraft {
  readonly mode: CreationMode;
  readonly prompt: string;
  readonly references: readonly DraftImageInput[];
  readonly target?: DraftImageInput | undefined;
  readonly supportingImages: readonly DraftImageInput[];
  readonly invariants: EditInvariantsDraft;
  readonly controls: CreationControls;
}

export interface CreationAvailability {
  readonly imageInput: boolean;
  readonly edit: boolean;
}

export type SubmissionState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "result"; readonly result: StudioImageOperationResult }
  | { readonly status: "failure"; readonly safeMessage: string };

export type CreationInputSlot = "reference" | "target" | "supporting";
