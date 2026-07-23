import type {
  BrowserResourceDescriptor,
  ReadSettingsResult,
  StudioBatchResult,
  StudioImageArtifact,
  StudioImageInputRef,
  StudioImageOperationResult,
  UploadResourceDescriptor,
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
  readonly descriptor?: UploadResourceDescriptor | undefined;
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
  readonly resource?: BrowserResourceDescriptor | undefined;
  readonly upload?: UploadLifecycleItem | undefined;
}

export interface CreationVisibleControls {
  readonly size: ReadSettingsResult["defaults"]["size"];
  readonly aspectRatio: ReadSettingsResult["defaults"]["aspectRatio"];
  readonly format: ReadSettingsResult["defaults"]["format"];
  readonly count: ReadSettingsResult["defaults"]["count"];
  readonly transparentMode: ReadSettingsResult["defaults"]["transparentMode"];
}

export interface CreationControls extends CreationVisibleControls {
  readonly quality: ReadSettingsResult["defaults"]["quality"];
  readonly compression?: number | undefined;
  readonly partialImages: ReadSettingsResult["defaults"]["partialImages"];
  readonly moderation: ReadSettingsResult["defaults"]["moderation"];
  readonly action: "auto" | "generate" | "edit";
  readonly previousResponseId?: string | undefined;
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
  readonly mask?: {
    readonly image: StudioImageInputRef;
    readonly targetSlot: 0;
  } | undefined;
  readonly maskUpload?: UploadLifecycleItem | undefined;
  readonly invariants: EditInvariantsDraft;
  readonly controls: CreationControls;
}

export interface BatchDraftItem {
  readonly id: string;
  readonly draft: CreationDraft;
}

export type BatchSubmissionState =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly taskIds: readonly string[] }
  | {
      readonly status: "result";
      readonly result: StudioBatchResult;
      readonly replayAcknowledged: boolean;
    }
  | { readonly status: "failure"; readonly safeMessage: string };

export type SubmissionState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | {
      readonly status: "streaming";
      readonly requestId: string;
      readonly partialArtifacts: readonly StudioImageArtifact[];
      readonly receivedAnyOutput: boolean;
      readonly mayHaveBilled: boolean;
    }
  | { readonly status: "result"; readonly result: StudioImageOperationResult }
  | {
      readonly status: "stream-failure";
      readonly requestId?: string | undefined;
      readonly safeMessage: string;
      readonly partialArtifacts: readonly StudioImageArtifact[];
      readonly receivedAnyOutput: boolean;
      readonly mayHaveBilled: boolean;
      readonly failureKind: "terminal" | "invalid" | "transport" | "cancelled";
      readonly automaticReplayAllowed: false;
    }
  | { readonly status: "failure"; readonly safeMessage: string };

export type CreationInputSlot = "reference" | "target" | "supporting";
