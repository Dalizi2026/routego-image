import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import type { ReadSettingsResult, RoutegoStatusResult } from "@routego-image/contracts";

import { StudioGatewayError, type StudioGateway } from "../api";
import { AppNavigation, AsyncStatePanel, NoticeStack } from "../components";
import { I18nProvider, useI18n, type MessageKey } from "../i18n";
import "../styles/index.css";
import {
  initialStudioAppState,
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
          <dd>{service.providerId ?? t("status.unconfigured")}</dd>
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

function StudioWorkspace({
  service,
  settings,
  routeContent
}: {
  readonly service: RoutegoStatusResult;
  readonly settings: ReadSettingsResult;
  readonly routeContent?: Partial<Record<StudioRoute, ReactNode>>;
}) {
  const { language, t, toggleLanguage } = useI18n();
  const [state, dispatch] = useReducer(studioAppReducer, {
    ...initialStudioAppState,
    notices: noticesFor(service, settings)
  });
  const headingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    headingRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [state.route]);

  return (
    <div className="studio-shell" data-language={language}>
      <a className="skip-link" href="#studio-workspace">
        {t("app.skip")}
      </a>
      <AppNavigation route={state.route} onNavigate={(route) => dispatch({ type: "navigate", route })} />
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
      <NoticeStack
        notices={state.notices}
        onDismiss={(id) => dispatch({ type: "dismiss-notice", id })}
      />
      <main id="studio-workspace" className="studio-workspace" ref={headingRef}>
        <section className="studio-workspace__primary" aria-live="polite">
          {routeContent?.[state.route] ?? <RouteOverview route={state.route} />}
        </section>
        <StatusLedger service={service} settings={settings} />
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

  return (
    <I18nProvider>
      {boot.status === "ready" ? (
        <StudioWorkspace
          service={boot.service}
          settings={boot.settings}
          {...(routeContent === undefined ? {} : { routeContent })}
        />
      ) : (
        <BootScreen state={boot} onRetry={() => setAttempt((value) => value + 1)} />
      )}
    </I18nProvider>
  );
}
