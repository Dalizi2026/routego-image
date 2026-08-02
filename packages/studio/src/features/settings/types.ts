import type { EndpointInputMode, ReadSettingsResult } from "@routego-image/contracts";

export type SettingsAsyncState =
  | { readonly status: "idle" }
  | { readonly status: "busy"; readonly operation: string }
  | { readonly status: "success"; readonly message: string }
  | { readonly status: "failure"; readonly safeMessage: string };

export interface ProviderEndpointDraft {
  readonly mode: EndpointInputMode;
  readonly value: string;
  readonly requiresReentry: boolean;
}

export interface OptionalProviderEndpointDraft {
  readonly value: string;
  readonly requiresReentry: boolean;
}

export interface ProviderProfileDraft {
  readonly profileId?: string | undefined;
  readonly name: string;
  readonly generation: ProviderEndpointDraft;
  readonly models: OptionalProviderEndpointDraft;
  readonly edits: OptionalProviderEndpointDraft;
  readonly responses: OptionalProviderEndpointDraft;
  readonly defaultModel: string;
  readonly apiKeyOperation: "unchanged" | "replace" | "clear";
  readonly apiKeyReplacement: string;
  readonly setActive: boolean;
}

export interface OutputDirectoryDraft {
  readonly operation: "unchanged" | "default" | "clear" | "replace";
  readonly path: string;
  readonly confirmLocalPath: boolean;
}

export interface SettingsWorkspaceProps {
  readonly gateway: import("../../api").StudioGateway;
  readonly settings: ReadSettingsResult;
  readonly onSettingsChange: (settings: ReadSettingsResult) => void;
  readonly firstRunSession?: boolean | undefined;
  readonly onboardingPreview?: boolean | undefined;
  readonly onReplayOnboarding?: (() => void) | undefined;
  readonly onProviderSaved?: (() => void) | undefined;
}

export interface ProviderSwitchFeedback {
  readonly providerId: string;
  readonly model?: string | undefined;
  readonly retainedModel: boolean;
}
