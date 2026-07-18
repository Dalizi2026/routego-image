import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";

import type {
  ExecuteLibraryMutationResult,
  LibraryAssetDetail,
  StudioLibrarySearchItem
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { AsyncStatePanel, ProtectedImage } from "../../components";
import { useI18n } from "../../i18n";
import { ImageComparison } from "./ImageComparison";
import { LibraryMutationPanel } from "./LibraryMutationPanel";
import {
  orderedLibraryRelationships,
  relationshipResourceInput,
  selectComparisonRelationships
} from "./comparison";
import { fetchLibraryDownload, triggerLibraryDownload } from "./download";
import {
  createLibraryEditHandoff,
  createLibraryRetryHandoff,
  isIdentifierOnlyLibraryHandoff
} from "./handoff";
import {
  advanceLibraryPage,
  buildLibrarySearchInput,
  createLibraryFilters,
  currentLibraryCursor,
  initialLibraryPage,
  LibraryQueryError,
  retreatLibraryPage
} from "./query";
import { remainingSelectedAssetIds } from "./mutations";
import type {
  AssetDetailState,
  FolderState,
  LibraryCreationHandoff,
  LibraryFilters,
  LibrarySearchState,
  LibraryView,
  RelationshipResourceState
} from "./types";
import "./library.css";

const copy = {
  zh: {
    libraryEyebrow: "ARCHIVE / 02",
    trashEyebrow: "RETENTION / 03",
    libraryTitle: "底片档案与成片图库",
    trashTitle: "回收站与保留记录",
    librarySubtitle: "用受保护缩略图、稳定标识符和契约筛选浏览本地作品，不读取任意文件路径。",
    trashSubtitle: "软删除内容在这里单独浏览。默认保留策略为 30 天，恢复和永久删除将在后续安全流程中执行。",
    filterTitle: "检索暗袋",
    query: "提示词检索",
    queryPlaceholder: "搜索提示词内容",
    models: "模型",
    modelsPlaceholder: "多个模型用逗号分隔",
    from: "开始日期",
    to: "结束日期",
    kinds: "任务类型",
    sizes: "尺寸",
    statuses: "状态",
    sort: "排序",
    limit: "每页",
    apply: "应用筛选",
    reset: "重置",
    allFolders: "全部档案夹",
    folders: "档案夹",
    folderFailure: "档案夹无法载入",
    retry: "重试",
    loading: "正在读取受保护图库",
    empty: "没有符合当前筛选的作品",
    emptyBody: "保留当前筛选，或重置条件查看其他本地作品。",
    searchFailure: "图库检索未完成",
    page: "页",
    previous: "上一页",
    next: "下一页",
    total: "总数",
    openDetail: "查看详情",
    deletedAt: "删除时间",
    createdAt: "创建时间",
    close: "关闭详情",
    detailLoading: "正在装载档案详情",
    detailFailure: "档案详情无法载入",
    requested: "请求参数",
    effective: "实际参数",
    execution: "执行记录",
    relationships: "关系底片",
    renditions: "图像版本",
    allowedActions: "允许动作",
    comparison: "源图 / 结果对比",
    comparisonControl: "调整源图与结果图的对比分隔线",
    source: "源图",
    output: "结果",
    edit: "继续编辑",
    retryRequest: "按此参数重试",
    download: "下载受保护图像",
    downloading: "正在准备下载…",
    handoffFailure: "无法建立安全的工作台接力。",
    noPreview: "没有受保护缩略图",
    relationFailure: "关系图像无法解析",
    partial: "部分结果",
    error: "结构化错误",
    foldersEmpty: "未归入档案夹",
    retention: "30 天保留策略",
    mutationLater: "使用图库多选和安全变更台执行文件夹、回收站与 ZIP 操作。",
    selectItem: "选择图库项目",
    selectPage: "选择当前页",
    clearPage: "取消当前页选择",
    selectedCount: "已选择"
  },
  en: {
    libraryEyebrow: "ARCHIVE / 02",
    trashEyebrow: "RETENTION / 03",
    libraryTitle: "Negative archive & finished Library",
    trashTitle: "Trash & retention record",
    librarySubtitle: "Browse local work through protected thumbnails, stable identifiers, and contract filters—never arbitrary file paths.",
    trashSubtitle: "Soft-deleted work is browsed separately. The default retention policy is 30 days; restore and permanent deletion remain guarded later workflows.",
    filterTitle: "Archive search sleeve",
    query: "Prompt query",
    queryPlaceholder: "Search prompt text",
    models: "Models",
    modelsPlaceholder: "Separate multiple models with commas",
    from: "From date",
    to: "To date",
    kinds: "Operation kind",
    sizes: "Size",
    statuses: "Status",
    sort: "Sort",
    limit: "Per page",
    apply: "Apply filters",
    reset: "Reset",
    allFolders: "All folders",
    folders: "Folders",
    folderFailure: "Folders could not load",
    retry: "Retry",
    loading: "Loading the protected Library",
    empty: "No work matches these filters",
    emptyBody: "Keep the filters or reset them to inspect other local work.",
    searchFailure: "Library search did not complete",
    page: "Page",
    previous: "Previous",
    next: "Next",
    total: "Total",
    openDetail: "Open detail",
    deletedAt: "Deleted",
    createdAt: "Created",
    close: "Close detail",
    detailLoading: "Loading archive detail",
    detailFailure: "Archive detail could not load",
    requested: "Requested parameters",
    effective: "Effective parameters",
    execution: "Execution record",
    relationships: "Relationship negatives",
    renditions: "Renditions",
    allowedActions: "Allowed actions",
    comparison: "Source / result comparison",
    comparisonControl: "Adjust the source and result comparison divider",
    source: "Source",
    output: "Result",
    edit: "Continue editing",
    retryRequest: "Retry these parameters",
    download: "Download protected image",
    downloading: "Preparing download…",
    handoffFailure: "A safe workbench handoff could not be created.",
    noPreview: "No protected thumbnail",
    relationFailure: "Relationship image could not be resolved",
    partial: "Partial result",
    error: "Structured error",
    foldersEmpty: "No folder membership",
    retention: "30-day retention policy",
    mutationLater: "Use Library multi-selection and the guarded mutation desk for folder, Trash, and ZIP actions.",
    selectItem: "Select Library item",
    selectPage: "Select current page",
    clearPage: "Clear current-page selection",
    selectedCount: "Selected"
  }
} as const;

type Labels = { readonly [Key in keyof (typeof copy)["zh"]]: string };

const kindOptions = ["generate", "edit"] as const;
const sizeOptions = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
const statusOptions = ["queued", "running", "succeeded", "partial", "failed"] as const;

function toggleValue<Value extends string>(
  values: readonly Value[],
  value: Value
): readonly Value[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function formatTimestamp(value: string, language: "zh" | "en"): string {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function relationLabel(role: string, language: "zh" | "en"): string {
  const labels = language === "zh"
    ? {
        source: "源图",
        target: "编辑目标",
        reference: "参考图",
        supporting: "辅助图",
        mask: "遮罩",
        output: "结果"
      }
    : {
        source: "Source",
        target: "Target",
        reference: "Reference",
        supporting: "Supporting",
        mask: "Mask",
        output: "Output"
      };
  return labels[role as keyof typeof labels] ?? role;
}

function FilterPanel({
  filters,
  view,
  labels,
  errors,
  onChange,
  onSubmit,
  onReset
}: {
  readonly filters: LibraryFilters;
  readonly view: LibraryView;
  readonly labels: Labels;
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (filters: LibraryFilters) => void;
  readonly onSubmit: () => void;
  readonly onReset: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className="library-filters" onSubmit={submit}>
      <div className="library-filters__heading">
        <p>FILTER / CONTRACT</p>
        <h2>{labels.filterTitle}</h2>
      </div>
      <div className="library-filters__grid">
        <label>
          <span>{labels.query}</span>
          <input
            value={filters.query}
            placeholder={labels.queryPlaceholder}
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
          />
        </label>
        <label>
          <span>{labels.models}</span>
          <input
            value={filters.models}
            placeholder={labels.modelsPlaceholder}
            onChange={(event) => onChange({ ...filters, models: event.target.value })}
          />
        </label>
        <label>
          <span>{labels.from}</span>
          <input
            type="date"
            value={filters.from}
            onChange={(event) => onChange({ ...filters, from: event.target.value })}
          />
          {errors["from"] ? <small role="alert">{errors["from"]}</small> : null}
        </label>
        <label>
          <span>{labels.to}</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => onChange({ ...filters, to: event.target.value })}
          />
          {errors["to"] ? <small role="alert">{errors["to"]}</small> : null}
        </label>
        <label>
          <span>{labels.sort}</span>
          <select
            value={filters.sort}
            onChange={(event) =>
              onChange({ ...filters, sort: event.target.value as LibraryFilters["sort"] })
            }
          >
            <option value="created-desc">created ↓</option>
            <option value="created-asc">created ↑</option>
            <option value="prompt-asc">prompt A–Z</option>
            <option value="prompt-desc">prompt Z–A</option>
          </select>
        </label>
        <label>
          <span>{labels.limit}</span>
          <select
            value={filters.limit}
            onChange={(event) => onChange({ ...filters, limit: Number(event.target.value) })}
          >
            {[6, 12, 24, 50].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <fieldset>
        <legend>{labels.kinds}</legend>
        {kindOptions.map((value) => (
          <label key={value}>
            <input
              type="checkbox"
              checked={filters.kinds.includes(value)}
              onChange={() => onChange({ ...filters, kinds: toggleValue(filters.kinds, value) })}
            />
            {value}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{labels.sizes}</legend>
        {sizeOptions.map((value) => (
          <label key={value}>
            <input
              type="checkbox"
              checked={filters.sizes.includes(value)}
              onChange={() => onChange({ ...filters, sizes: toggleValue(filters.sizes, value) })}
            />
            {value}
          </label>
        ))}
      </fieldset>
      {view === "library" ? (
        <fieldset>
          <legend>{labels.statuses}</legend>
          {statusOptions.map((value) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={filters.statuses.includes(value)}
                onChange={() =>
                  onChange({ ...filters, statuses: toggleValue(filters.statuses, value) })
                }
              />
              {value}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="library-filters__actions">
        <button type="submit">{labels.apply}</button>
        <button type="button" onClick={onReset}>{labels.reset}</button>
      </div>
    </form>
  );
}

function GalleryCard({
  gateway,
  item,
  labels,
  language,
  detailSelected,
  checked,
  onCheckedChange,
  onOpen
}: {
  readonly gateway: StudioGateway;
  readonly item: StudioLibrarySearchItem;
  readonly labels: Labels;
  readonly language: "zh" | "en";
  readonly detailSelected: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly onOpen: () => void;
}) {
  return (
    <article className={`library-card${detailSelected ? " is-selected" : ""}${checked ? " is-checked" : ""}`}>
      <label className="library-card__selection">
        <input
          type="checkbox"
          checked={checked}
          aria-label={`${labels.selectItem}: ${item.prompt}`}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <span aria-hidden="true">{checked ? "✓" : "+"}</span>
      </label>
      <button
        className="library-card__open"
        type="button"
        aria-label={`${labels.openDetail}: ${item.prompt}`}
        onClick={onOpen}
      >
        <div className="library-card__image" style={{ aspectRatio: `${item.width} / ${item.height}` }}>
          {item.thumbnail === undefined ? (
            <span>{labels.noPreview}</span>
          ) : (
            <ProtectedImage gateway={gateway} descriptor={item.thumbnail} alt={item.prompt} />
          )}
          <span className={`library-card__status library-card__status--${item.status}`}>
            {item.status}
          </span>
        </div>
        <div className="library-card__body">
          <p>{item.kind.toUpperCase()} / {item.model}</p>
          <h2>{item.prompt}</h2>
          <dl>
            <div><dt>{labels.createdAt}</dt><dd>{formatTimestamp(item.createdAt, language)}</dd></div>
            <div><dt>FRAME</dt><dd>{item.width} × {item.height}</dd></div>
            {item.deletedAt === undefined ? null : (
              <div><dt>{labels.deletedAt}</dt><dd>{formatTimestamp(item.deletedAt, language)}</dd></div>
            )}
          </dl>
        </div>
      </button>
    </article>
  );
}

function resourceForRelationship(
  states: readonly RelationshipResourceState[],
  relationshipId: string | undefined
) {
  return states.find(
    (state) => state.status === "ready" && state.relationship.id === relationshipId
  );
}

function ParameterLedger({
  title,
  parameters
}: {
  readonly title: string;
  readonly parameters: LibraryAssetDetail["effectiveParams"];
}) {
  return (
    <section className="library-detail__section">
      <h3>{title}</h3>
      <dl className="library-parameter-ledger">
        <div><dt>KIND</dt><dd>{parameters.kind}</dd></div>
        <div><dt>SIZE</dt><dd>{parameters.size}</dd></div>
        <div><dt>ASPECT</dt><dd>{parameters.aspectRatio}</dd></div>
        <div><dt>QUALITY</dt><dd>{parameters.quality}</dd></div>
        <div><dt>FORMAT</dt><dd>{parameters.format}</dd></div>
        <div><dt>COUNT</dt><dd>{parameters.count}</dd></div>
        <div><dt>PARTIAL</dt><dd>{parameters.partialImages}</dd></div>
        <div><dt>TRANSPARENCY</dt><dd>{parameters.transparentMode}</dd></div>
        <div><dt>MODERATION</dt><dd>{parameters.moderation}</dd></div>
        <div><dt>ACTION</dt><dd>{parameters.action}</dd></div>
      </dl>
    </section>
  );
}

function DetailDrawer({
  gateway,
  state,
  resources,
  labels,
  language,
  actionMessage,
  actionBusy,
  onClose,
  onHandoff,
  onDownload
}: {
  readonly gateway: StudioGateway;
  readonly state: AssetDetailState;
  readonly resources: readonly RelationshipResourceState[];
  readonly labels: Labels;
  readonly language: "zh" | "en";
  readonly actionMessage?: string | undefined;
  readonly actionBusy: boolean;
  readonly onClose: () => void;
  readonly onHandoff: (action: "retry" | "edit", asset: LibraryAssetDetail) => void;
  readonly onDownload: (asset: LibraryAssetDetail) => void;
}) {
  if (state.status === "idle") return null;
  const asset = state.status === "ready" ? state.asset : undefined;
  const comparison = asset === undefined ? {} : selectComparisonRelationships(asset);
  const sourceState = resourceForRelationship(resources, comparison.source?.id);
  const outputState = resourceForRelationship(resources, comparison.output?.id);
  return (
    <div className="library-detail" role="dialog" aria-modal="true" aria-labelledby="library-detail-title">
      <div className="library-detail__scrim" onClick={onClose} aria-hidden="true" />
      <aside className="library-detail__panel">
        <header>
          <div>
            <p>CONTACT SHEET / DETAIL</p>
            <h2 id="library-detail-title">
              {asset?.prompt ?? (state.status === "loading" ? labels.detailLoading : labels.detailFailure)}
            </h2>
          </div>
          <button type="button" onClick={onClose}>{labels.close}</button>
        </header>
        {state.status === "loading" ? (
          <AsyncStatePanel state="loading" title={labels.detailLoading}><p>{state.assetId}</p></AsyncStatePanel>
        ) : state.status === "failure" ? (
          <AsyncStatePanel state="failure" title={labels.detailFailure}><p>{state.safeMessage}</p></AsyncStatePanel>
        ) : asset !== undefined ? (
          <div className="library-detail__content">
            <section className="library-detail__hero">
              <div>
                <span className={`library-detail__status library-detail__status--${asset.status}`}>{asset.status}</span>
                <p>{asset.kind.toUpperCase()} · {asset.model}</p>
                <p>{formatTimestamp(asset.createdAt, language)}</p>
              </div>
              <div className="library-detail__actions">
                {asset.allowedActions.includes("retry") ? (
                  <button type="button" onClick={() => onHandoff("retry", asset)}>{labels.retryRequest}</button>
                ) : null}
                {asset.allowedActions.includes("edit") ? (
                  <button type="button" onClick={() => onHandoff("edit", asset)}>{labels.edit}</button>
                ) : null}
                {asset.allowedActions.includes("download") ? (
                  <button type="button" disabled={actionBusy} onClick={() => onDownload(asset)}>
                    {actionBusy ? labels.downloading : labels.download}
                  </button>
                ) : null}
              </div>
              {actionMessage ? <p className="library-detail__action-message" role="status">{actionMessage}</p> : null}
            </section>

            {sourceState?.status === "ready" && outputState?.status === "ready" ? (
              <section className="library-detail__section">
                <h3>{labels.comparison}</h3>
                <ImageComparison
                  gateway={gateway}
                  source={sourceState.resource}
                  output={outputState.resource}
                  sourceLabel={labels.source}
                  outputLabel={labels.output}
                  controlLabel={labels.comparisonControl}
                />
              </section>
            ) : null}

            <ParameterLedger title={labels.requested} parameters={asset.requestedParams} />
            <ParameterLedger title={labels.effective} parameters={asset.effectiveParams} />

            <section className="library-detail__section">
              <h3>{labels.execution}</h3>
              <dl className="library-parameter-ledger">
                <div><dt>TRANSPORT</dt><dd>{asset.execution.transport}</dd></div>
                <div><dt>ATTEMPTS</dt><dd>{asset.execution.attemptCount}</dd></div>
                <div><dt>PROVIDER CALLS</dt><dd>{asset.execution.providerRequestCount}</dd></div>
                <div><dt>OUTPUT</dt><dd>{String(asset.execution.receivedAnyOutput)}</dd></div>
                <div><dt>MAY HAVE BILLED</dt><dd>{String(asset.execution.mayHaveBilled)}</dd></div>
                <div><dt>DEGRADED</dt><dd>{String(asset.execution.degradedContinuation)}</dd></div>
              </dl>
              {asset.error ? (
                <div className="library-detail__error" role="alert">
                  <strong>{labels.error}</strong>
                  <span>{asset.error.safeMessage}</span>
                </div>
              ) : null}
            </section>

            <section className="library-detail__section">
              <h3>{labels.relationships}</h3>
              <div className="relationship-strip">
                {orderedLibraryRelationships(asset).map((relationship) => {
                  const resource = resources.find((state) => state.relationship.id === relationship.id);
                  return (
                    <article key={relationship.id}>
                      <div className="relationship-strip__image">
                        {resource?.status === "ready" ? (
                          <ProtectedImage
                            gateway={gateway}
                            descriptor={resource.resource}
                            alt={`${relationLabel(relationship.role, language)} ${relationship.order + 1}`}
                          />
                        ) : resource?.status === "failure" ? (
                          <span role="alert">{labels.relationFailure}</span>
                        ) : (
                          <span>{labels.loading}</span>
                        )}
                      </div>
                      <p>{String(relationship.order + 1).padStart(2, "0")} / {relationLabel(relationship.role, language)}</p>
                      <strong>{relationship.label ?? relationship.relatedAssetId}</strong>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="library-detail__section library-detail__split">
              <div>
                <h3>{labels.renditions}</h3>
                <ul>{asset.renditions.map((rendition) => (
                  <li key={rendition.artifactId}>{rendition.phase} · {rendition.mimeType} · {rendition.width} × {rendition.height}</li>
                ))}</ul>
              </div>
              <div>
                <h3>{labels.folders}</h3>
                {asset.folders.length === 0 ? <p>{labels.foldersEmpty}</p> : (
                  <ul>{asset.folders.map((folder) => <li key={folder.folderId}>{folder.name}</li>)}</ul>
                )}
              </div>
            </section>

            <section className="library-detail__section">
              <h3>{labels.allowedActions}</h3>
              <div className="library-action-ledger">
                {asset.allowedActions.map((action) => <span key={action}>{action}</span>)}
              </div>
              <p>{labels.mutationLater}</p>
            </section>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

export function LibraryWorkspace({
  gateway,
  view,
  onCreationHandoff
}: {
  readonly gateway: StudioGateway;
  readonly view: LibraryView;
  readonly onCreationHandoff: (handoff: LibraryCreationHandoff) => void;
}) {
  const { language } = useI18n();
  const labels = copy[language];
  const initialFilters = useMemo(() => createLibraryFilters(view), [view]);
  const [filters, setFilters] = useState<LibraryFilters>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<LibraryFilters>(initialFilters);
  const [page, setPage] = useState(initialLibraryPage);
  const [searchState, setSearchState] = useState<LibrarySearchState>({ status: "loading" });
  const [folderState, setFolderState] = useState<FolderState>({ status: "loading" });
  const [filterErrors, setFilterErrors] = useState<Readonly<Record<string, string>>>({});
  const [searchRevision, setSearchRevision] = useState(0);
  const [folderRevision, setFolderRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [selectedAssetId, setSelectedAssetId] = useState<string | undefined>();
  const [selectedAssetIds, setSelectedAssetIds] = useState<readonly string[]>([]);
  const [detailState, setDetailState] = useState<AssetDetailState>({ status: "idle" });
  const [relationshipResources, setRelationshipResources] = useState<
    readonly RelationshipResourceState[]
  >([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | undefined>();
  const searchRequestRef = useRef(0);
  const cursor = currentLibraryCursor(page);

  useEffect(() => {
    let active = true;
    setFolderState({ status: "loading" });
    void gateway
      .invoke("listFolders", { includeDeleted: view === "trash" })
      .then((result) => {
        if (active) setFolderState({ status: "ready", folders: result.folders });
      })
      .catch((error) => {
        if (active) {
          setFolderState({
            status: "failure",
            safeMessage: error instanceof Error ? error.message : labels.folderFailure
          });
        }
      });
    return () => {
      active = false;
    };
  }, [folderRevision, gateway, labels.folderFailure, view]);

  useEffect(() => {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    let input;
    try {
      input = buildLibrarySearchInput(appliedFilters, view, cursor);
    } catch (error) {
      if (error instanceof LibraryQueryError) {
        setFilterErrors(error.fields);
        setSearchState({ status: "failure", safeMessage: error.message });
        return;
      }
      setSearchState({ status: "failure", safeMessage: labels.searchFailure });
      return;
    }
    setSearchState({ status: "loading" });
    void gateway
      .invoke("searchStudioLibrary", input)
      .then((result) => {
        if (searchRequestRef.current !== requestId) return;
        setSearchState(
          result.items.length === 0
            ? { status: "empty", ...(result.total === undefined ? {} : { total: result.total }) }
            : {
                status: "ready",
                items: result.items,
                ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
                ...(result.total === undefined ? {} : { total: result.total })
              }
        );
      })
      .catch((error) => {
        if (searchRequestRef.current === requestId) {
          setSearchState({
            status: "failure",
            safeMessage: error instanceof Error ? error.message : labels.searchFailure
          });
        }
      });
  }, [appliedFilters, cursor, gateway, labels.searchFailure, searchRevision, view]);

  useEffect(() => {
    if (selectedAssetId === undefined) {
      setDetailState({ status: "idle" });
      setRelationshipResources([]);
      return;
    }
    let active = true;
    setDetailState({ status: "loading", assetId: selectedAssetId });
    setRelationshipResources([]);
    setActionMessage(undefined);
    void gateway
      .invoke("getAssetDetail", { assetId: selectedAssetId })
      .then(async (result) => {
        if (!active) return;
        if (result.status !== "succeeded" || result.asset === undefined) {
          setDetailState({
            status: "failure",
            assetId: selectedAssetId,
            safeMessage: result.error?.safeMessage ?? labels.detailFailure
          });
          return;
        }
        const asset = result.asset;
        setDetailState({ status: "ready", asset });
        const ordered = orderedLibraryRelationships(asset);
        setRelationshipResources(
          ordered.map((relationship) => ({ status: "loading", relationship }))
        );
        const resources = await Promise.all(
          ordered.map(async (relationship): Promise<RelationshipResourceState> => {
            try {
              const resolved = await gateway.invoke(
                "getBrowserResource",
                relationshipResourceInput(relationship)
              );
              return resolved.status === "succeeded" && resolved.resource !== undefined
                ? { status: "ready", relationship, resource: resolved.resource }
                : {
                    status: "failure",
                    relationship,
                    safeMessage: resolved.error?.safeMessage ?? labels.relationFailure
                  };
            } catch (error) {
              return {
                status: "failure",
                relationship,
                safeMessage: error instanceof Error ? error.message : labels.relationFailure
              };
            }
          })
        );
        if (active) setRelationshipResources(resources);
      })
      .catch((error) => {
        if (active) {
          setDetailState({
            status: "failure",
            assetId: selectedAssetId,
            safeMessage: error instanceof Error ? error.message : labels.detailFailure
          });
        }
      });
    return () => {
      active = false;
    };
  }, [detailRevision, gateway, labels.detailFailure, labels.relationFailure, selectedAssetId]);

  const applyFilters = useCallback(() => {
    try {
      buildLibrarySearchInput(filters, view);
      setFilterErrors({});
      setAppliedFilters(filters);
      setPage(initialLibraryPage());
    } catch (error) {
      if (error instanceof LibraryQueryError) {
        setFilterErrors(error.fields);
        setSearchState({ status: "failure", safeMessage: error.message });
      }
    }
  }, [filters, view]);

  const resetFilters = useCallback(() => {
    const next = createLibraryFilters(view);
    setFilters(next);
    setAppliedFilters(next);
    setFilterErrors({});
    setPage(initialLibraryPage());
  }, [view]);

  const selectFolder = useCallback(
    (folderId: string | undefined) => {
      const next = { ...filters, folderId };
      setFilters(next);
      setAppliedFilters(next);
      setPage(initialLibraryPage());
    },
    [filters]
  );

  const handoff = useCallback(
    (action: "retry" | "edit", asset: LibraryAssetDetail) => {
      try {
        const next = action === "retry" ? createLibraryRetryHandoff(asset) : createLibraryEditHandoff(asset);
        if (!isIdentifierOnlyLibraryHandoff(next)) throw new Error(labels.handoffFailure);
        onCreationHandoff(next);
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : labels.handoffFailure);
      }
    },
    [labels.handoffFailure, onCreationHandoff]
  );

  const download = useCallback(
    async (asset: LibraryAssetDetail) => {
      setActionBusy(true);
      setActionMessage(undefined);
      try {
        const result = await fetchLibraryDownload(gateway, asset);
        triggerLibraryDownload(result);
        setActionMessage(result.fileName);
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : labels.detailFailure);
      } finally {
        setActionBusy(false);
      }
    },
    [gateway, labels.detailFailure]
  );

  const refreshLibraryState = useCallback(() => {
    setSearchRevision((value) => value + 1);
    setFolderRevision((value) => value + 1);
    setDetailRevision((value) => value + 1);
  }, []);

  const handleMutationResult = useCallback(
    (result: ExecuteLibraryMutationResult) => {
      setSelectedAssetIds((current) => remainingSelectedAssetIds(current, result));
      const leavesCurrentView =
        result.action === "permanent-delete" ||
        (view === "library" && result.action === "soft-delete") ||
        (view === "trash" && result.action === "restore");
      if (
        leavesCurrentView &&
        selectedAssetId !== undefined &&
        result.items.some(
          (item) =>
            item.status === "succeeded" &&
            (item.targetId === selectedAssetId || item.affectedAssetId === selectedAssetId)
        )
      ) {
        setSelectedAssetId(undefined);
      }
    },
    [selectedAssetId, view]
  );

  const items = searchState.status === "ready" ? searchState.items : [];
  const currentPageIds = items.map((item) => item.assetId);
  const allCurrentPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((assetId) => selectedAssetIds.includes(assetId));
  const total = searchState.status === "ready" || searchState.status === "empty"
    ? searchState.total
    : undefined;
  return (
    <section className={`library-workspace library-workspace--${view}`}>
      <header className="library-workspace__header">
        <p>{view === "library" ? labels.libraryEyebrow : labels.trashEyebrow}</p>
        <h1 tabIndex={-1}>{view === "library" ? labels.libraryTitle : labels.trashTitle}</h1>
        <span>{view === "library" ? labels.librarySubtitle : labels.trashSubtitle}</span>
        {view === "trash" ? <strong>{labels.retention}</strong> : null}
      </header>

      <div className="library-workspace__tools">
        <nav className="library-folders" aria-label={labels.folders}>
          <button
            type="button"
            aria-pressed={filters.folderId === undefined}
            onClick={() => selectFolder(undefined)}
          >
            {labels.allFolders}
          </button>
          {folderState.status === "ready"
            ? folderState.folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  aria-pressed={filters.folderId === folder.id}
                  onClick={() => selectFolder(folder.id)}
                >
                  <span>{folder.name}</span>
                  <small>{folder.assetCount}</small>
                </button>
              ))
            : null}
          {folderState.status === "failure" ? (
            <span role="alert">
              {folderState.safeMessage}
              <button type="button" onClick={() => setFolderRevision((value) => value + 1)}>
                {labels.retry}
              </button>
            </span>
          ) : null}
        </nav>
        <FilterPanel
          filters={filters}
          view={view}
          labels={labels}
          errors={filterErrors}
          onChange={setFilters}
          onSubmit={applyFilters}
          onReset={resetFilters}
        />
      </div>

      <div className="library-workspace__summary">
        <span>{labels.page} {page.index + 1}</span>
        <button
          type="button"
          disabled={currentPageIds.length === 0}
          onClick={() =>
            setSelectedAssetIds((current) =>
              allCurrentPageSelected
                ? current.filter((assetId) => !currentPageIds.includes(assetId))
                : [...new Set([...current, ...currentPageIds])]
            )
          }
        >
          {allCurrentPageSelected ? labels.clearPage : labels.selectPage}
        </button>
        <span>{labels.selectedCount} {selectedAssetIds.length}</span>
        {total === undefined ? null : <span>{labels.total} {total}</span>}
      </div>

      {searchState.status === "loading" ? (
        <AsyncStatePanel state="loading" title={labels.loading}><p>{labels.librarySubtitle}</p></AsyncStatePanel>
      ) : searchState.status === "failure" ? (
        <AsyncStatePanel
          state="failure"
          title={labels.searchFailure}
          action={<button type="button" onClick={() => setSearchRevision((value) => value + 1)}>{labels.retry}</button>}
        >
          <p>{searchState.safeMessage}</p>
        </AsyncStatePanel>
      ) : searchState.status === "empty" ? (
        <AsyncStatePanel
          state="empty"
          title={labels.empty}
          action={<button type="button" onClick={resetFilters}>{labels.reset}</button>}
        >
          <p>{labels.emptyBody}</p>
        </AsyncStatePanel>
      ) : (
        <div className="library-gallery" aria-live="polite">
          {items.map((item) => (
            <GalleryCard
              key={item.assetId}
              gateway={gateway}
              item={item}
              labels={labels}
              language={language}
              detailSelected={selectedAssetId === item.assetId}
              checked={selectedAssetIds.includes(item.assetId)}
              onCheckedChange={(checked) =>
                setSelectedAssetIds((current) =>
                  checked
                    ? [...new Set([...current, item.assetId])]
                    : current.filter((assetId) => assetId !== item.assetId)
                )
              }
              onOpen={() => setSelectedAssetId(item.assetId)}
            />
          ))}
        </div>
      )}

      <LibraryMutationPanel
        gateway={gateway}
        view={view}
        folders={folderState.status === "ready" ? folderState.folders : []}
        selectedAssetIds={selectedAssetIds}
        onFoldersChange={(folders) => setFolderState({ status: "ready", folders })}
        onMutationResult={handleMutationResult}
        onRefresh={refreshLibraryState}
      />

      <nav className="library-pagination" aria-label={`${labels.page} ${page.index + 1}`}>
        <button
          type="button"
          disabled={page.index === 0 || searchState.status === "loading"}
          onClick={() => setPage((current) => retreatLibraryPage(current))}
        >
          {labels.previous}
        </button>
        <span>{String(page.index + 1).padStart(2, "0")}</span>
        <button
          type="button"
          disabled={searchState.status !== "ready" || searchState.nextCursor === undefined}
          onClick={() =>
            setPage((current) =>
              advanceLibraryPage(
                current,
                searchState.status === "ready" ? searchState.nextCursor : undefined
              )
            )
          }
        >
          {labels.next}
        </button>
      </nav>

      <DetailDrawer
        gateway={gateway}
        state={detailState}
        resources={relationshipResources}
        labels={labels}
        language={language}
        actionMessage={actionMessage}
        actionBusy={actionBusy}
        onClose={() => setSelectedAssetId(undefined)}
        onHandoff={handoff}
        onDownload={(asset) => void download(asset)}
      />
    </section>
  );
}
