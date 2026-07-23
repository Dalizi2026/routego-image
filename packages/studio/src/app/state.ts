import type { ReadSettingsResult } from "@routego-image/contracts";

import type { MessageKey } from "../i18n";

export const studioRoutes = ["workbench", "library", "trash", "settings"] as const;
export type StudioRoute = (typeof studioRoutes)[number];

export type NoticeTone = "success" | "degraded" | "empty" | "failure";

export interface AppNotice {
  readonly id: string;
  readonly tone: NoticeTone;
  readonly title: MessageKey;
  readonly body: MessageKey;
  readonly dismissible?: boolean;
}

export interface StudioAppState {
  readonly route: StudioRoute;
  readonly notices: readonly AppNotice[];
  readonly providerSwitch: ProviderSwitchState;
}

export type ProviderSwitchState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly providerId: string }
  | {
      readonly status: "success";
      readonly providerId: string;
      readonly model: string;
      readonly retainedModel: boolean;
    }
  | { readonly status: "failure"; readonly providerId: string; readonly message: string };

export type StudioAppAction =
  | { readonly type: "navigate"; readonly route: StudioRoute }
  | { readonly type: "replace-notices"; readonly notices: readonly AppNotice[] }
  | { readonly type: "dismiss-notice"; readonly id: string }
  | { readonly type: "provider-switch-start"; readonly providerId: string }
  | {
      readonly type: "provider-switch-success";
      readonly providerId: string;
      readonly model: string;
      readonly retainedModel: boolean;
    }
  | {
      readonly type: "provider-switch-failure";
      readonly providerId: string;
      readonly message: string;
    };

export const initialStudioAppState: StudioAppState = {
  route: "workbench",
  notices: [],
  providerSwitch: { status: "idle" }
};

export interface FirstRunReadiness {
  readonly hasActiveProfile: boolean;
  readonly hasApiKey: boolean;
  readonly hasModel: boolean;
  readonly complete: boolean;
}

export function firstRunReadiness(settings: ReadSettingsResult): FirstRunReadiness {
  const activeProfile = settings.profiles.find(
    (profile) => profile.id === settings.activeProviderId && profile.isActive
  );
  const hasActiveProfile = activeProfile !== undefined;
  const hasApiKey = activeProfile?.hasApiKey === true;
  const hasModel =
    (settings.defaults.model?.trim().length ?? 0) > 0 ||
    (activeProfile?.defaultModel?.trim().length ?? 0) > 0;
  return {
    hasActiveProfile,
    hasApiKey,
    hasModel,
    complete: hasActiveProfile && hasApiKey && hasModel
  };
}

export function initialStudioRouteForSettings(settings: ReadSettingsResult): StudioRoute {
  return firstRunReadiness(settings).complete ? "workbench" : "settings";
}

export function studioAppReducer(
  state: StudioAppState,
  action: StudioAppAction
): StudioAppState {
  switch (action.type) {
    case "navigate":
      return action.route === state.route ? state : { ...state, route: action.route };
    case "replace-notices":
      return { ...state, notices: action.notices };
    case "dismiss-notice":
      return { ...state, notices: state.notices.filter((notice) => notice.id !== action.id) };
    case "provider-switch-start":
      return {
        ...state,
        providerSwitch: { status: "loading", providerId: action.providerId }
      };
    case "provider-switch-success":
      return {
        ...state,
        providerSwitch: {
          status: "success",
          providerId: action.providerId,
          model: action.model,
          retainedModel: action.retainedModel
        }
      };
    case "provider-switch-failure":
      return {
        ...state,
        providerSwitch: {
          status: "failure",
          providerId: action.providerId,
          message: action.message
        }
      };
  }
}

export type NavigationMode = "rail" | "bottom";

export function navigationModeForWidth(width: number): NavigationMode {
  return width < 720 ? "bottom" : "rail";
}
