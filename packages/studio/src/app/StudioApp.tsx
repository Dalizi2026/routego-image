import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import type {
  LegacyLibraryMigrationState,
  ReadSettingsResult,
  RoutegoStatusResult
} from "@routego-image/contracts";

import { StudioGatewayError, type StudioGateway } from "../api";
import { AppNavigation, AsyncStatePanel, NoticeStack } from "../components";
import { LibraryWorkspace } from "../features/library";
import { GenerationDefaultsPanel, SettingsWorkspace } from "../features/settings";
import { mergeStudioProviderSwitch } from "../features/settings/state";
import { I18nProvider, useI18n, type MessageKey } from "../i18n";
import "../styles/index.css";
import {
  initialStudioAppState,
  initialStudioRouteForSettings,
  studioAppReducer,
  type AppNotice,
  type StudioRoute
} from "./state";

type BootState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly service: RoutegoStatusResult;
      readonly settings: ReadSettingsResult;
      readonly migration: LegacyLibraryMigrationState;
    }
  | {
      readonly status: "failure";
      readonly message: MessageKey;
      readonly reopenOnly: boolean;
    };

const routeCopy: Record<
  StudioRoute,
  {
    readonly index: string;
    readonly eyebrow: MessageKey;
    readonly title: MessageKey;
    readonly body: MessageKey;
  }
> = {
  workbench: {
    index: "01",
    eyebrow: "route.workbench.eyebrow",
    title: "route.workbench.title",
    body: "route.workbench.body"
  },
  library: {
    index: "02",
    eyebrow: "route.library.eyebrow",
    title: "route.library.title",
    body: "route.library.body"
  },
  settings: {
    index: "03",
    eyebrow: "route.settings.eyebrow",
    title: "route.settings.title",
    body: "route.settings.body"
  }
};

function noticesFor(service: RoutegoStatusResult, settings: ReadSettingsResult): AppNotice[] {
  const notices: AppNotice[] = [];
  if (service.service.status === "degraded") {
    notices.push({
      id: "service-degraded",
      tone: "degraded",
      title: "notice.degradedTitle",
      body: "notice.degradedBody"
    });
  }
  if (settings.profiles.length === 0) {
    notices.push({
      id: "profiles-empty",
      tone: "empty",
      title: "notice.emptyTitle",
      body: "notice.emptyBody"
    });
  }
  return notices;
}

function BootScreen({ state, onRetry }: { readonly state: BootState; readonly onRetry: () => void }) {
  const { t } = useI18n();
  if (state.status === "loading") {
    return (
      <div className="boot-screen">
        <div className="boot-screen__aperture" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <AsyncStatePanel state="loading" title={t("app.loadingTitle")}>
          <p>{t("app.loadingBody")}</p>
        </AsyncStatePanel>
      </div>
    );
  }
  if (state.status === "failure") {
    return (
      <div className="boot-screen">
        <AsyncStatePanel
          state="failure"
          title={t("app.errorTitle")}
          action={
            state.reopenOnly ? null : (
              <button className="studio-button" type="button" onClick={onRetry}>
                {t("app.retry")}
              </button>
            )
          }
        >
          <p>{t(state.message)}</p>
          {state.reopenOnly ? <p>{t("app.reopen")}</p> : null}
        </AsyncStatePanel>
      </div>
    );
  }
  return null;
}

function LegacyMigrationScreen({
  gateway,
  migration,
  onRetry
}: {
  readonly gateway: StudioGateway;
  readonly migration: LegacyLibraryMigrationState;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirm = useCallback(() => {
    if (migration.status !== "ready" || migration.fingerprint === undefined || working) return;
    setWorking(true);
    setFailed(false);
    void gateway.invoke("confirmLegacyLibraryMigration", {
      fingerprint: migration.fingerprint,
      confirmMigration: true
    }).then((result) => {
      if (result.status === "succeeded") onRetry();
      else setFailed(true);
    }).catch(() => setFailed(true)).finally(() => setWorking(false));
  }, [gateway, migration, onRetry, working]);
  return (
    <div className="boot-screen">
      <AsyncStatePanel
        state={migration.status === "ready" ? "degraded" : "failure"}
        title={t("migration.title")}
        action={migration.status === "ready" ? (
          <button className="studio-button" type="button" disabled={working} onClick={confirm}>
            {working ? t("migration.working") : t("migration.confirm")}
          </button>
        ) : (
          <button className="studio-button" type="button" onClick={onRetry}>{t("app.retry")}</button>
        )}
      >
        <p>{migration.status === "ready" ? t("migration.ready") : t("migration.blocked")}</p>
        {failed ? <p>{t("migration.failed")}</p> : null}
      </AsyncStatePanel>
    </div>
  );
}

function RouteOverview({ route }: { readonly route: StudioRoute }) {
  const { t } = useI18n();
  const copy = routeCopy[route];
  return (
    <div className="route-overview">
      <div className="route-overview__index" aria-hidden="true">
        {copy.index}
      </div>
      <p className="route-overview__eyebrow">{t(copy.eyebrow)}</p>
      <h1 tabIndex={-1}>{t(copy.title)}</h1>
      <p className="route-overview__lead">{t(copy.body)}</p>
      <div className="route-overview__rule" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <AsyncStatePanel state="empty" title={t("route.shellReady")}>
        <p>{t("route.shellReadyBody")}</p>
      </AsyncStatePanel>
    </div>
  );
}

export function HeaderProviderSelector({
  settings,
  gateway,
  onSettingsChange,
  onOpenSettings
}: {
  readonly settings: ReadSettingsResult;
  readonly gateway: StudioGateway;
  readonly onSettingsChange: (settings: ReadSettingsResult) => void;
  readonly onOpenSettings: () => void;
}) {
  const { language, t } = useI18n();
  const activeProvider = settings.profiles.find(
    (profile) => profile.id === settings.activeProviderId && profile.isActive
  );
  const [switching, setSwitching] = useState(false);
  const copy =
    language === "zh"
      ? {
          label: "服务商",
          settings: "前往设置",
          noModel: "未配置模型"
        }
      : {
          label: "Provider",
          settings: "Settings",
          noModel: "No model configured"
        };

  return (
    <div className="provider-switch">
      <span className="provider-switch__label">{copy.label}</span>
      <select
        aria-label={copy.label}
        value={settings.activeProviderId ?? ""}
        disabled={switching || settings.profiles.length === 0}
        onChange={(event) => {
          const profileId = event.target.value;
          if (profileId === "" || profileId === settings.activeProviderId) return;
          setSwitching(true);
          void gateway.invoke("studioProviderSwitch", {
            profileId,
            ...(settings.defaults.model === undefined ? {} : { preferredModel: settings.defaults.model })
          }).then((result) => {
            if (result.status === "succeeded") onSettingsChange(mergeStudioProviderSwitch(settings, result));
          }).finally(() => setSwitching(false));
        }}
      >
        {settings.profiles.length === 0 ? <option value="">{t("status.unconfigured")}</option> : settings.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
      <span className="provider-switch__model">{switching ? "…" : settings.defaults.model ?? activeProvider?.defaultModel ?? copy.noModel}</span>
      <button className="provider-switch__settings" type="button" onClick={onOpenSettings}>{copy.settings}</button>
    </div>
  );
}

function StudioWorkspace({
  gateway,
  service,
  settings,
  onSettingsChange,
  routeContent
}: {
  readonly gateway: StudioGateway;
  readonly service: RoutegoStatusResult;
  readonly settings: ReadSettingsResult;
  readonly onSettingsChange: (settings: ReadSettingsResult) => void;
  readonly routeContent?: Partial<Record<StudioRoute, ReactNode>>;
}) {
  const { language, t, toggleLanguage } = useI18n();
  const firstRunSession = useRef(initialStudioRouteForSettings(settings) === "settings").current;
  const [state, dispatch] = useReducer(studioAppReducer, {
    ...initialStudioAppState,
    route: initialStudioRouteForSettings(settings),
    notices: firstRunSession ? [] : noticesFor(service, settings)
  });
  const firstRunSetupVisible = firstRunSession && state.route === "settings";
  const workbenchContent = routeContent?.workbench ?? (
    <GenerationDefaultsPanel gateway={gateway} settings={settings} onSettingsChange={onSettingsChange} />
  );
  const content = {
    library:
      routeContent?.library ?? (
        <LibraryWorkspace
          gateway={gateway}
          view="library"
        />
      ),
    settings:
      routeContent?.settings ?? (
        <SettingsWorkspace
          gateway={gateway}
          settings={settings}
          onSettingsChange={onSettingsChange}
          firstRunSession={firstRunSession}
          onOpenWorkbench={() => dispatch({ type: "navigate", route: "workbench" })}
        />
      )
  } satisfies Partial<Record<Exclude<StudioRoute, "workbench">, ReactNode>>;
  const headingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    headingRef.current
      ?.querySelector<HTMLElement>(`[data-studio-route="${state.route}"] h1`)
      ?.focus();
  }, [state.route]);

  return (
    <div
      className={`studio-shell${firstRunSetupVisible ? " studio-shell--setup" : ""}`}
      data-language={language}
    >
      <a className="skip-link" href="#studio-workspace">
        {t("app.skip")}
      </a>
      {firstRunSetupVisible ? null : (
        <AppNavigation route={state.route} onNavigate={(route) => dispatch({ type: "navigate", route })} />
      )}
      <header className="studio-header">
        <div className="studio-header__identity">
          <p>{t("app.brand")}</p>
          <span>{t("app.edition")}</span>
        </div>
        <div className="studio-header__controls">
          <span className="local-chip">
            <i aria-hidden="true" />
            {t("app.localOnly")}
          </span>
          <HeaderProviderSelector
            settings={settings}
            gateway={gateway}
            onSettingsChange={onSettingsChange}
            onOpenSettings={() => dispatch({ type: "navigate", route: "settings" })}
          />
          <button
            className="language-toggle"
            type="button"
            aria-label={t("app.language")}
            onClick={toggleLanguage}
          >
            <span>{language === "zh" ? "中" : "EN"}</span>
            {t("app.languageAction")}
          </button>
        </div>
      </header>
      {firstRunSetupVisible ? null : (
        <NoticeStack
          notices={state.notices}
          onDismiss={(id) => dispatch({ type: "dismiss-notice", id })}
        />
      )}
      <main
        id="studio-workspace"
        className={`studio-workspace${firstRunSetupVisible ? " studio-workspace--setup" : ""}`}
        ref={headingRef}
      >
        <section className="studio-workspace__primary" aria-live="polite">
          <div data-studio-route="workbench" hidden={state.route !== "workbench"}>
            {workbenchContent}
          </div>
          {state.route === "workbench" ? null : (
            <div data-studio-route={state.route}>
              {content[state.route] ?? <RouteOverview route={state.route} />}
            </div>
          )}
        </section>
      </main>
      <footer className="studio-footer">
        <span>ROUTEGO IMAGE / LOCAL PRODUCTION SURFACE</span>
        <span aria-hidden="true">F·8 — 1/125 — ISO 400</span>
      </footer>
    </div>
  );
}

export function StudioApp({
  gateway,
  routeContent
}: {
  readonly gateway: StudioGateway;
  readonly routeContent?: Partial<Record<StudioRoute, ReactNode>>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [boot, setBoot] = useState<BootState>({ status: "loading" });
  const updateSettings = useCallback((settings: ReadSettingsResult) => {
    setBoot((current) =>
      current.status === "ready" ? { ...current, settings } : current
    );
  }, []);

  useEffect(() => {
    let active = true;
    setBoot({ status: "loading" });
    void Promise.all([
      gateway.invoke("status", {}),
      gateway.invoke("readSettings", {}),
      gateway.invoke("readLegacyLibraryMigration", {})
    ])
      .then(([service, settings, migration]) => {
        if (!active) {
          return;
        }
        if (!service.service.studioAvailable) {
          setBoot({
            status: "failure",
            reopenOnly: true,
            message: "app.studioUnavailable"
          });
          return;
        }
        setBoot({ status: "ready", service, settings, migration });
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        const gatewayError = error instanceof StudioGatewayError ? error : undefined;
        setBoot({
          status: "failure",
          reopenOnly: gatewayError?.status === 401,
          message:
            gatewayError?.status === 401 ? "app.sessionRejected" : "app.serviceUnavailable"
        });
      });
    return () => {
      active = false;
    };
  }, [attempt, gateway]);

  return (
    <I18nProvider>
      {boot.status === "ready" && boot.migration.status !== "not-required" ? (
        <LegacyMigrationScreen
          gateway={gateway}
          migration={boot.migration}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : boot.status === "ready" ? (
        <StudioWorkspace
          gateway={gateway}
          service={boot.service}
          settings={boot.settings}
          onSettingsChange={updateSettings}
          {...(routeContent === undefined ? {} : { routeContent })}
        />
      ) : (
        <BootScreen state={boot} onRetry={() => setAttempt((value) => value + 1)} />
      )}
    </I18nProvider>
  );
}
