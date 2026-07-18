import type { AppNotice } from "../app/state";
import { useI18n } from "../i18n";

export function NoticeStack({
  notices,
  onDismiss
}: {
  readonly notices: readonly AppNotice[];
  readonly onDismiss: (id: string) => void;
}) {
  const { t } = useI18n();
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notice-stack" aria-label={t("notice.label")}>
      {notices.map((notice) => (
        <section
          className={`notice notice--${notice.tone}`}
          key={notice.id}
          role={notice.tone === "failure" ? "alert" : "status"}
        >
          <span className="notice__lamp" aria-hidden="true" />
          <div>
            <h2>{t(notice.title)}</h2>
            <p>{t(notice.body)}</p>
          </div>
          {notice.dismissible ? (
            <button
              className="notice__dismiss"
              type="button"
              aria-label={t("notice.dismiss")}
              onClick={() => onDismiss(notice.id)}
            >
              ×
            </button>
          ) : null}
        </section>
      ))}
    </div>
  );
}
