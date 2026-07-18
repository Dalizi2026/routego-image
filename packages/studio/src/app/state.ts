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
}

export type StudioAppAction =
  | { readonly type: "navigate"; readonly route: StudioRoute }
  | { readonly type: "replace-notices"; readonly notices: readonly AppNotice[] }
  | { readonly type: "dismiss-notice"; readonly id: string };

export const initialStudioAppState: StudioAppState = {
  route: "workbench",
  notices: []
};

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
  }
}

export type NavigationMode = "rail" | "bottom";

export function navigationModeForWidth(width: number): NavigationMode {
  return width < 720 ? "bottom" : "rail";
}
