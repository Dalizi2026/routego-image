import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import type { ReadSettingsResult, RoutegoStatusResult } from "@routego-image/contracts";

import { StudioGatewayError, type StudioGateway } from "../api";
import { AppNavigation, AsyncStatePanel, NoticeStack } from "../components";
import { CapabilityProvider } from "../features/capabilities";
import {
  CreationWorkbench,
  type CreationExternalHandoff
} from "../features/creation";
import {
  LibraryWorkspace,
  type LibraryCreationHandoff
} from "../features/library";
import { SettingsWorkspace } from "../features/settings";
import {
  activeSettingsModel,
  isValidatedActiveProviderResult,
  mergeActiveProviderProfile
} from "../features/settings/state";
import { I18nProvider, useI18n, type MessageKey } from "../i18n";
import "../styles/index.css";
import {
  initialStudioAppState,
  initialStudioRouteForSettings,
  studioAppReducer,
  type AppNotice,
  type ProviderSwitchState,
  type StudioRoute
} from "./state";

type BootState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly service: RoutegoStatusResult;
      readonly settings: ReadSettingsResult;
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
  trash: {
    index: "03",
    eyebrow: "route.trash.eyebrow",
    title: "route.trash.title",
    body: "route.trash.body"
  },
  settings: {
    index: "04",
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
  } else {
    notices.push({
      id: "service-ready",
      tone: "success",
      title: "notice.readyTitle",
      body: "notice.readyBody",
      dismissible: true
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

function StatusLedger({
  service,
  settings
}: {
  readonly service: RoutegoStatusResult;
  readonly settings: ReadSettingsResult;
}) {
  const { t } = useI18n();
  const isDegraded = service.service.status === "degraded";
  return (
    <aside className="status-ledger" aria-labelledby="status-ledger-title">
      <div className="status-ledger__heading">
        <p>SYS / 01</p>
        <h2 id="status-ledger-title">{t("status.title")}</h2>
      </div>
      <dl>
        <div>
          <dt>{t("status.service")}</dt>
          <dd className={isDegraded ? "is-degraded" : "is-ready"}>
            <span aria-hidden="true" />
            {isDegraded ? t("app.degraded") : t("app.ready")}
          </dd>
        </div>
        <div>
          <dt>{t("status.provider")}</dt>
          <dd>{settings.activeProviderId ?? service.providerId ?? t("status.unconfigured")}</dd>
        </div>
        <div>
          <dt>{t("app.profiles")}</dt>
          <dd>
            {settings.profiles.length} {t("app.profilesUnit")}
          </dd>
        </div>
        <div>
          <dt>{t("status.security")}</dt>
          <dd>{t("status.protected")}</dd>
        </div>
        <div>
          <dt>{t("app.session")}</dt>
          <dd>{t("app.memoryOnly")}</dd>
        </div>
      </dl>
      <div className="status-ledger__scale" aria-hidden="true">
        {Array.from({ length: 18 }, (_, index) => (
          <i key={index} />
        ))}
      </div>
    </aside>
  );
}

export function HeaderProviderSelector({
  gateway,
  settings,
  state,
  onSettingsChange,
  onStateChange
}: {
  readonly gateway: StudioGateway;
  readonly settings: ReadSettingsResult;
  readonly state: ProviderSwitchState;
  readonly onSettingsChange: (settings: ReadSettingsResult) => void;
  readonly onStateChange: (
    action:
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
        }
  ) => void;
}) {
  const { language, t } = useI18n();
  const activeModel = activeSettingsModel(settings);
  const activeProvider = settings.profiles.find(
    (profile) => profile.id === settings.activeProviderId && profile.isActive
  );
  const loading = state.status === "loading";
  const copy =
    language === "zh"
      ? {
          label: "服务商",
          snapshot: "已提交的请求保留提交时的服务商和模型；新选择仅影响后续提交。",
          loading: "正在切换服务商……",
          retained: "当前模型已保留，后续提交将使用此服务商。",
          fallback: "当前模型不可用，已切换到目标服务商默认模型。",
          failure: "服务商切换失败，仍保留原来的选择。",
          noModel: "未配置模型"
        }
      : {
          label: "Provider",
          snapshot:
            "Submitted requests keep their provider and model snapshots; this selection affects future submissions only.",
          loading: "Switching provider...",
          retained: "The current model was retained for future submissions.",
          fallback: "The current model was unavailable; the target default model is active.",
          failure: "Provider switch failed; the previous selection is still active.",
          noModel: "No model configured"
        };

  const handleChange = async (providerId: string) => {
    if (!providerId || providerId === settings.activeProviderId || loading) return;
    onStateChange({ type: "provider-switch-start", providerId });
    try {
      const result = await gateway.invoke("setActiveProviderProfile", {
        schemaVersion: 1,
        providerId
      });
      if (!isValidatedActiveProviderResult(result, providerId)) {
        throw new Error("Invalid provider activation response.");
      }
      const nextSettings = mergeActiveProviderProfile(settings, result);
      const nextModel = activeSettingsModel(nextSettings);
      if (nextModel === undefined) {
        throw new Error("Provider activation did not return a model.");
      }
      onSettingsChange(nextSettings);
      onStateChange({
        type: "provider-switch-success",
        providerId,
        model: nextModel,
        retainedModel: activeModel !== undefined && nextModel === activeModel
      });
    } catch {
      onStateChange({
        type: "provider-switch-failure",
        providerId,
        message: copy.failure
      });
    }
  };

  return (
    <div className="provider-switch" data-provider-switch-state={state.status}>
      <label className="provider-switch__label" htmlFor="studio-provider-select">
        {copy.label}
      </label>
      <select
        id="studio-provider-select"
        className="provider-switch__select"
        value={settings.activeProviderId ?? ""}
        disabled={loading || settings.profiles.length < 2}
        aria-busy={loading}
        onChange={(event) => void handleChange(event.currentTarget.value)}
      >
        {settings.profiles.length === 0 ? (
          <option value="">{t("status.unconfigured")}</option>
        ) : (
          settings.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))
        )}
      </select>
      <span className="provider-switch__model">
        {activeProvider?.name ?? t("status.unconfigured")} / {activeModel ?? copy.noModel}
      </span>
      <p className="provider-switch__snapshot">{copy.snapshot}</p>
      {state.status === "loading" ? (
        <p className="provider-switch__status" role="status" aria-live="polite">
          {copy.loading}
        </p>
      ) : null}
      {state.status === "success" ? (
        <p className="provider-switch__status provider-switch__status--success" role="status">
          {state.retainedModel ? copy.retained : copy.fallback} ({state.model})
        </p>
      ) : null}
      {state.status === "failure" ? (
        <p className="provider-switch__status provider-switch__status--failure" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

export interface StudioLibraryHandoffTransition {
  readonly route: "workbench";
  readonly handoff: CreationExternalHandoff;
}

export function createStudioLibraryHandoffTransition(
  handoff: LibraryCreationHandoff,
  sequence: number
): StudioLibraryHandoffTransition {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Library handoff sequence must be a positive integer.");
  }
  return {
    route: "workbench",
    handoff: {
      id: `library:${sequence}:${handoff.action}`,
      draft: handoff.draft
    }
  };
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
  const [creationHandoff, setCreationHandoff] = useState<CreationExternalHandoff>();
  const handoffSequenceRef = useRef(0);
  const handleCreationHandoff = useCallback((handoff: LibraryCreationHandoff) => {
    handoffSequenceRef.current += 1;
    const transition = createStudioLibraryHandoffTransition(
      handoff,
      handoffSequenceRef.current
    );
    setCreationHandoff(transition.handoff);
    dispatch({ type: "navigate", route: transition.route });
  }, []);
  const workbenchContent = routeContent?.workbench ?? (
      <CreationWorkbench
        gateway={gateway}
        defaults={settings.defaults}
        externalHandoff={creationHandoff}
      />
    );
  const content = {
    library:
      routeContent?.library ?? (
        <LibraryWorkspace
          gateway={gateway}
          view="library"
          onCreationHandoff={handleCreationHandoff}
        />
      ),
    trash:
      routeContent?.trash ?? (
        <LibraryWorkspace
          gateway={gateway}
          view="trash"
          onCreationHandoff={handleCreationHandoff}
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
            gateway={gateway}
            settings={settings}
            state={state.providerSwitch}
            onSettingsChange={onSettingsChange}
            onStateChange={(action) => dispatch(action)}
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
        {firstRunSetupVisible ? null : <StatusLedger service={service} settings={settings} />}
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
    void Promise.all([gateway.invoke("status", {}), gateway.invoke("readSettings", {})])
      .then(([service, settings]) => {
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
        setBoot({ status: "ready", service, settings });
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

  const activeProfile =
    boot.status === "ready"
      ? boot.settings.profiles.find(
          (profile) =>
            profile.id === boot.settings.activeProviderId && profile.isActive
        )
      : undefined;

  return (
    <I18nProvider>
      {boot.status === "ready" ? (
        <CapabilityProvider
          providerId={boot.settings.activeProviderId ?? boot.service.providerId}
          model={
            boot.settings.defaults.model ??
            activeProfile?.defaultModel ??
            activeProfile?.models[0] ??
            boot.service.models[0]
          }
          snapshots={boot.service.capabilities}
        >
          <StudioWorkspace
            gateway={gateway}
            service={boot.service}
            settings={boot.settings}
            onSettingsChange={updateSettings}
            {...(routeContent === undefined ? {} : { routeContent })}
          />
        </CapabilityProvider>
      ) : (
        <BootScreen state={boot} onRetry={() => setAttempt((value) => value + 1)} />
      )}
    </I18nProvider>
  );
}
