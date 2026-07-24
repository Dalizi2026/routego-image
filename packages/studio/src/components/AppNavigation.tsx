import type { StudioRoute } from "../app/state";
import { useI18n, type MessageKey } from "../i18n";

const routes: ReadonlyArray<{
  readonly id: StudioRoute;
  readonly label: MessageKey;
  readonly index: string;
}> = [
  { id: "workbench", label: "nav.workbench", index: "01" },
  { id: "library", label: "nav.library", index: "02" },
  { id: "settings", label: "nav.settings", index: "03" }
];

export function AppNavigation({
  route,
  onNavigate
}: {
  readonly route: StudioRoute;
  readonly onNavigate: (route: StudioRoute) => void;
}) {
  const { t } = useI18n();
  return (
    <nav className="studio-nav" aria-label={t("nav.label")}>
      <div className="studio-nav__brand" aria-hidden="true">
        <span>RG</span>
        <i />
      </div>
      <div className="studio-nav__routes">
        {routes.map((item) => (
          <button
            className="studio-nav__item"
            type="button"
            key={item.id}
            aria-current={route === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <span className="studio-nav__index" aria-hidden="true">
              {item.index}
            </span>
            <span className="studio-nav__label">{t(item.label)}</span>
          </button>
        ))}
      </div>
      <div className="studio-nav__local" aria-hidden="true">
        <span className="studio-nav__pulse" />
        LOCAL
      </div>
    </nav>
  );
}
