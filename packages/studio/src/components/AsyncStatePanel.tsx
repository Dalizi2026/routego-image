import type { ReactNode } from "react";

import { useI18n, type MessageKey } from "../i18n";

export type AsyncState = "loading" | "empty" | "success" | "partial" | "failure" | "degraded";

const labelKeys: Record<AsyncState, MessageKey> = {
  loading: "state.loading",
  empty: "state.empty",
  success: "state.success",
  partial: "state.partial",
  failure: "state.failure",
  degraded: "state.degraded"
};

export function AsyncStatePanel({
  state,
  title,
  children,
  action
}: {
  readonly state: AsyncState;
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section
      className={`async-state async-state--${state}`}
      role={state === "failure" ? "alert" : "status"}
      aria-live={state === "failure" ? "assertive" : "polite"}
      aria-busy={state === "loading"}
    >
      <div className="async-state__mark" aria-hidden="true">
        <span />
      </div>
      <div className="async-state__copy">
        <p className="async-state__label">{t(labelKeys[state])}</p>
        <h2>{title}</h2>
        <div className="async-state__body">{children}</div>
      </div>
      {action === undefined ? null : <div className="async-state__action">{action}</div>}
    </section>
  );
}
