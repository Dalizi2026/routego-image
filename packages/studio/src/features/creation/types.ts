import type { ReadSettingsResult, StudioBatchResult, StudioImageArtifact, StudioImageOperationResult } from "@routego-image/contracts";

export type CreationMode = "generate";

export interface CreationVisibleControls {
  readonly size: ReadSettingsResult["defaults"]["size"];
  readonly aspectRatio: ReadSettingsResult["defaults"]["aspectRatio"];
  readonly format: ReadSettingsResult["defaults"]["format"];
  readonly count: ReadSettingsResult["defaults"]["count"];
  readonly transparentMode: ReadSettingsResult["defaults"]["transparentMode"];
}

export type CreationControls = CreationVisibleControls;

export interface CreationDraft {
  readonly mode: CreationMode;
  readonly prompt: string;
  readonly references: readonly never[];
  readonly controls: CreationControls;
}

export interface BatchDraftItem {
  readonly id: string;
  readonly prompt: string;
  readonly size: CreationVisibleControls["size"];
  readonly aspectRatio: CreationVisibleControls["aspectRatio"];
  readonly count: CreationVisibleControls["count"];
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
