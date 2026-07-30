import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";

import type {
  BrowserResourceDescriptor,
  ExecuteLibraryMutationResult,
  LibraryAssetDetail,
  ProviderProfileDescriptor,
  RoutegoManageLibraryResult,
  StudioLibrarySearchItem
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { AsyncStatePanel, ProtectedImage } from "../../components";
import { useI18n } from "../../i18n";
import { ImageComparison } from "./ImageComparison";
import {
  orderedLibraryRelationships,
  relationshipResourceInput,
  selectComparisonRelationships
} from "./comparison";
import { fetchLibraryDownload, triggerLibraryDownload } from "./download";
import {
  copiedGenerationInformation,
  createCopyGenerationInfoRequest,
  createMarkImageRequest,
  nextCurrentMarkRecordId,
  type CopyGenerationInfoResult,
  type MarkImageResult
} from "./handoff";
import {
  advanceLibraryPage,
  buildLibrarySearchInput,
  createLibraryFilters,
  currentLibraryCursor,
  initialLibraryPage,
  LibraryQueryError,
  paginationPageNumbers,
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

function invokeBrowserSafeLibraryAction<Result>(
  gateway: StudioGateway,
  path: "/api/v1/library/copy-generation-info" | "/api/v1/library/mark",
  input: { readonly schemaVersion: 1; readonly recordId: string }
): Promise<Result> {
  return (gateway.invoke as unknown as (operation: string, payload: typeof input) => Promise<Result>)(
    path,
    input
  );
}

const copy = {
  zh: {
    libraryEyebrow: "ARCHIVE / 02",
    libraryTitle: "图库",
    librarySubtitle: "用受保护缩略图、稳定标识符和契约筛选浏览本地作品，不读取任意文件路径。",
    filterTitle: "检索暗袋",
    query: "提示词检索",
    queryPlaceholder: "搜索提示词内容",
    provider: "服务商",
    allProviders: "全部服务商",
    from: "开始日期",
    to: "结束日期",
    kinds: "任务类型",
    sizes: "尺寸",
    statuses: "状态",
    sort: "排序",
    limit: "每页",
    advanced: "更多筛选",
    activeFilters: "项高级条件已启用",
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
    download: "下载受保护图像",
    downloading: "正在准备下载…",
    handoffFailure: "无法建立安全的工作台接力。",
    noPreview: "没有受保护缩略图",
    relationFailure: "关系图像无法解析",
    partial: "部分结果",
    error: "结构化错误",
    foldersEmpty: "未归入档案夹",
    selectItem: "选择图库项目",
    selectPage: "选择当前页",
    clearPage: "取消当前页选择",
    cancelSelection: "取消选择",
    selectedCount: "已选择"
    ,locations: "资源库位置"
    ,addLocation: "选择文件夹"
    ,add: "添加"
    ,moveSelected: "移动所选图片"
    ,moveTo: "移动到"
    ,deleteSelected: "删除所选图片"
    ,deleteConfirm: "将永久删除所选图片及其对应本地文件，无法撤销。是否继续？"
    ,renameHint: "双击名称可重命名"
    ,rename: "重命名"
    ,preview: "查看原图"
    ,closePreview: "关闭预览"
    ,workInfo: "作品信息与提示词"
    ,technicalInfo: "技术详情"
    ,comparisonInfo: "编辑前后对比"
    ,currentFolder: "当前文件夹："
    ,time: "生成时间"
    ,allTime: "全部时间"
    ,today: "今天"
    ,last24Hours: "24 小时内"
    ,last7Days: "一周内"
    ,last30Days: "30 天内"
    ,customTimeRange: "自定义时间范围"
  },
  en: {
    libraryEyebrow: "ARCHIVE / 02",
    libraryTitle: "Library",
    librarySubtitle: "Browse local work through protected thumbnails, stable identifiers, and contract filters—never arbitrary file paths.",
    filterTitle: "Archive search sleeve",
    query: "Prompt query",
    queryPlaceholder: "Search prompt text",
    provider: "Provider",
    allProviders: "All providers",
    from: "From date",
    to: "To date",
    kinds: "Operation kind",
    sizes: "Size",
    statuses: "Status",
    sort: "Sort",
    limit: "Per page",
    advanced: "More filters",
    activeFilters: "advanced filters active",
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
    download: "Download protected image",
    downloading: "Preparing download…",
    handoffFailure: "A safe workbench handoff could not be created.",
    noPreview: "No protected thumbnail",
    relationFailure: "Relationship image could not be resolved",
    partial: "Partial result",
    error: "Structured error",
    foldersEmpty: "No folder membership",
    selectItem: "Select Library item",
    selectPage: "Select current page",
    clearPage: "Clear current-page selection",
    cancelSelection: "Cancel selection",
    selectedCount: "Selected"
    ,locations: "Library directories"
    ,addLocation: "Choose folder"
    ,add: "Add"
    ,moveSelected: "Move selected images"
    ,moveTo: "Move to"
    ,deleteSelected: "Delete selected images"
    ,deleteConfirm: "Selected images and their corresponding local files will be permanently deleted. Continue?"
    ,renameHint: "Double-click a name to rename it"
    ,rename: "Rename"
    ,preview: "View original"
    ,closePreview: "Close preview"
    ,workInfo: "Artwork and prompt"
    ,technicalInfo: "Technical details"
    ,comparisonInfo: "Before / after comparison"
    ,currentFolder: "Current folder:"
    ,time: "Created"
    ,allTime: "All time"
    ,today: "Today"
    ,last24Hours: "Last 24 hours"
    ,last7Days: "Last 7 days"
    ,last30Days: "Last 30 days"
    ,customTimeRange: "Custom time range"
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

function formatCompactTimestamp(value: string, language: "zh" | "en"): string {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function relationLabel(role: string, language: "zh" | "en"): string {
  const labels = language === "zh"
    ? {
        source: "源图",
        reference: "参考图",
        output: "结果"
      }
    : {
        source: "Source",
        reference: "Reference",
        output: "Output"
      };
  return labels[role as keyof typeof labels] ?? role;
}

function assetStatusLabel(status: string, language: "zh" | "en"): string {
  if (language === "en") return status;
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "处理中",
    succeeded: "已完成",
    partial: "部分完成",
    failed: "失败",
    deleted: "已删除"
  };
  return labels[status] ?? status;
}

function FilterPanel({
  filters,
  labels,
  language,
  providers,
  errors,
  onChange,
  onSubmit,
  onReset
}: {
  readonly filters: LibraryFilters;
  readonly labels: Labels;
  readonly language: "zh" | "en";
  readonly providers: readonly ProviderProfileDescriptor[];
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (filters: LibraryFilters) => void;
  readonly onSubmit: () => void;
  readonly onReset: () => void;
}) {
  const activeAdvancedCount = [
    filters.providerId !== "",
    filters.from !== "",
    filters.to !== "",
    filters.sizes.length > 0,
    filters.statuses.length > 0
  ].filter(Boolean).length;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };
  const presetSize = filters.sizes.length === 1 ? filters.sizes[0] ?? "" : "";
  const presetStatus = filters.statuses.length === 1 ? filters.statuses[0] ?? "" : "";
  return (
    <form className="library-filters" onSubmit={submit}>
      <div className="library-filters__grid library-filters__grid--quick">
        <label className="library-filters__control library-filters__control--query">
          <span>{labels.query}</span>
          <input
            value={filters.query}
            placeholder={labels.queryPlaceholder}
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
          />
        </label>
        <label className="library-filters__control library-filters__control--sort">
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
        <label className="library-filters__control library-filters__control--limit">
          <span>{labels.limit}</span>
          <select
            value={filters.limit}
            onChange={(event) => onChange({ ...filters, limit: Number(event.target.value) })}
          >
            {[24, 30, 48, 60].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <div className="library-filters__actions">
          <button type="submit">{labels.apply}</button>
          <button type="button" onClick={onReset}>{labels.reset}</button>
        </div>
      </div>
      <div className="library-filters__grid library-filters__grid--reference">
        <label>
          <span>{labels.time}</span>
          <select
            value={filters.timeRange}
            onChange={(event) => {
              const timeRange = event.target.value as LibraryFilters["timeRange"];
              onChange({
                ...filters,
                timeRange,
                ...(timeRange === "custom" ? {} : { from: "", to: "" })
              });
            }}
          >
            <option value="all">{labels.allTime}</option>
            <option value="today">{labels.today}</option>
            <option value="last-24-hours">{labels.last24Hours}</option>
            <option value="last-7-days">{labels.last7Days}</option>
            <option value="last-30-days">{labels.last30Days}</option>
            <option value="custom">{labels.customTimeRange}</option>
          </select>
        </label>
        <label>
          <span>{labels.provider}</span>
          <select value={filters.providerId} onChange={(event) => onChange({ ...filters, providerId: event.target.value })}>
            <option value="">{labels.allProviders}</option>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </label>
        <label>
          <span>{labels.sizes}</span>
          <select value={presetSize} onChange={(event) => onChange({ ...filters, sizes: event.target.value === "" ? [] : [event.target.value as (typeof sizeOptions)[number]] })}>
            <option value="">{language === "zh" ? "全部" : "All"}</option>
            {sizeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>{labels.statuses}</span>
          <select value={presetStatus} onChange={(event) => onChange({ ...filters, statuses: event.target.value === "" ? [] : [event.target.value as (typeof statusOptions)[number]] })}>
            <option value="">{language === "zh" ? "全部" : "All"}</option>
            {statusOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      <details className="library-filters__advanced">
        <summary>{labels.advanced}{activeAdvancedCount > 0 ? ` · ${activeAdvancedCount} ${labels.activeFilters}` : ""}</summary>
        <div className="library-filters__grid">
          <label><span>{labels.from}</span><input type="date" value={filters.from} onChange={(event) => onChange({ ...filters, timeRange: "custom", from: event.target.value })} />{errors["from"] ? <small role="alert">{errors["from"]}</small> : null}</label>
          <label><span>{labels.to}</span><input type="date" value={filters.to} onChange={(event) => onChange({ ...filters, timeRange: "custom", to: event.target.value })} />{errors["to"] ? <small role="alert">{errors["to"]}</small> : null}</label>
        </div>
        <fieldset><legend>{labels.kinds}</legend>{kindOptions.map((value) => <label key={value}><input type="checkbox" checked={filters.kinds.includes(value)} onChange={() => onChange({ ...filters, kinds: toggleValue(filters.kinds, value) })} />{value}</label>)}</fieldset>
        <fieldset><legend>{labels.sizes}</legend>{sizeOptions.map((value) => <label key={value}><input type="checkbox" checked={filters.sizes.includes(value)} onChange={() => onChange({ ...filters, sizes: toggleValue(filters.sizes, value) })} />{value}</label>)}</fieldset>
        <fieldset><legend>{labels.statuses}</legend>{statusOptions.map((value) => <label key={value}><input type="checkbox" checked={filters.statuses.includes(value)} onChange={() => onChange({ ...filters, statuses: toggleValue(filters.statuses, value) })} />{value}</label>)}</fieldset>
      </details>
    </form>
  );
}

export function GalleryCard({
  gateway,
  item,
  labels,
  language,
  detailSelected,
  checked,
  selectionMode,
  onCheckedChange,
  editingName = false,
  onStartRename = () => undefined,
  onRename = () => undefined,
  onOpen
}: {
  readonly gateway: StudioGateway;
  readonly item: StudioLibrarySearchItem;
  readonly labels: Pick<Labels, "selectItem" | "openDetail" | "noPreview"> & Partial<Pick<Labels, "renameHint" | "rename">>;
  readonly language: "zh" | "en";
  readonly detailSelected: boolean;
  readonly checked: boolean;
  readonly selectionMode: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly editingName?: boolean;
  readonly onStartRename?: () => void;
  readonly onRename?: (name: string) => void;
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
        aria-label={`${selectionMode ? labels.selectItem : labels.openDetail}: ${item.prompt}`}
        onClick={() => selectionMode ? onCheckedChange(!checked) : onOpen()}
      >
        <div className="library-card__image">
          {item.thumbnail === undefined ? (
            <span>{labels.noPreview}</span>
          ) : (
            <ProtectedImage gateway={gateway} descriptor={item.thumbnail} alt={item.prompt} />
          )}
          <span className={`library-card__status library-card__status--${item.status}`}>
            {assetStatusLabel(item.status, language)}
          </span>
          <span className="library-card__frame">{item.width} × {item.height}</span>
        </div>
      </button>
      <div className="library-card__meta">
          {editingName ? (
            <input
              autoFocus
              aria-label={labels.rename ?? "Rename"}
              defaultValue={item.displayName ?? item.model}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => onRename(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") event.currentTarget.value = item.displayName ?? item.model;
              }}
            />
          ) : (
            <span title={labels.renameHint ?? "Double-click to rename"} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onStartRename(); }}>
              {item.displayName ?? item.model}
            </span>
          )}
          <time dateTime={item.createdAt} title={formatTimestamp(item.createdAt, language)}>
            {formatCompactTimestamp(item.createdAt, language)}
          </time>
      </div>
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
  currentMarkRecordId,
  onCopyGenerationInfo,
  onMarkImage,
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
  readonly currentMarkRecordId?: string | undefined;
  readonly onCopyGenerationInfo: (asset: LibraryAssetDetail) => void;
  readonly onMarkImage: (asset: LibraryAssetDetail) => void;
  readonly onDownload: (asset: LibraryAssetDetail) => void;
}) {
  const [previewResource, setPreviewResource] = useState<BrowserResourceDescriptor | undefined>();
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
            <p>IMAGE / DETAIL</p>
            <h2 id="library-detail-title">
              {asset?.displayName ?? (state.status === "loading" ? labels.detailLoading : labels.detailFailure)}
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
            <section className="library-detail__preview">
              {outputState?.status === "ready" ? (
                <>
                  <button
                    type="button"
                    className="library-detail__preview-image"
                    onClick={() => setPreviewResource(outputState.resource)}
                    aria-label={labels.preview}
                  >
                    <ProtectedImage
                      gateway={gateway}
                      descriptor={outputState.resource}
                      alt={asset.displayName ?? asset.model}
                    />
                  </button>
                  <button type="button" className="library-detail__preview-button" onClick={() => setPreviewResource(outputState.resource)}>
                    {labels.preview}
                  </button>
                </>
              ) : (
                <p className="library-detail__preview-loading">{labels.loading}</p>
              )}
            </section>

            <section className="library-detail__hero">
              <div>
                <span className={`library-detail__status library-detail__status--${asset.status}`}>{asset.status}</span>
                <p>{asset.kind.toUpperCase()} · {asset.model}</p>
                <p>{formatTimestamp(asset.createdAt, language)}</p>
              </div>
              <div className="library-detail__actions">
                {asset.allowedActions.includes("copy-generation-info") ? (
                  <button type="button" disabled={actionBusy} onClick={() => onCopyGenerationInfo(asset)}>
                    {language === "zh" ? "复制生成信息" : "Copy generation info"}
                  </button>
                ) : null}
                {asset.allowedActions.includes("mark") ? (
                  <button type="button" disabled={actionBusy} onClick={() => onMarkImage(asset)}>
                    {currentMarkRecordId === asset.id
                      ? language === "zh" ? "取消标记" : "Clear mark"
                      : language === "zh" ? "标记图片" : "Mark image"}
                  </button>
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
              <details className="library-detail__disclosure">
                <summary>{labels.comparisonInfo}</summary>
                <ImageComparison
                  gateway={gateway}
                  source={sourceState.resource}
                  output={outputState.resource}
                  sourceLabel={labels.source}
                  outputLabel={labels.output}
                  controlLabel={labels.comparisonControl}
                />
              </details>
            ) : null}

            <details className="library-detail__disclosure">
              <summary>{labels.workInfo}</summary>
              <p className="library-detail__prompt">{asset.prompt}</p>
              <p className="library-detail__meta">{asset.kind.toUpperCase()} · {asset.model} · {formatTimestamp(asset.createdAt, language)}</p>
            </details>

            <details className="library-detail__disclosure">
              <summary>{labels.technicalInfo}</summary>
              <div className="library-detail__technical-content">
                <ParameterLedger title={labels.effective} parameters={asset.effectiveParams} />
                <section className="library-detail__section">
                  <h3>{labels.execution}</h3>
                  <dl className="library-parameter-ledger">
                    <div><dt>TRANSPORT</dt><dd>{asset.execution.transport}</dd></div>
                    <div><dt>ATTEMPTS</dt><dd>{asset.execution.attemptCount}</dd></div>
                    <div><dt>PROVIDER CALLS</dt><dd>{asset.execution.providerRequestCount}</dd></div>
                    <div><dt>OUTPUT</dt><dd>{String(asset.execution.receivedAnyOutput)}</dd></div>
                  </dl>
                  {asset.error ? <div className="library-detail__error" role="alert"><strong>{labels.error}</strong><span>{asset.error.safeMessage}</span></div> : null}
                </section>
              </div>
            </details>
          </div>
        ) : null}
      </aside>
      {previewResource ? (
        <div className="library-image-preview" role="dialog" aria-modal="true" aria-label={labels.preview} onClick={() => setPreviewResource(undefined)}>
          <button type="button" className="library-image-preview__close" onClick={() => setPreviewResource(undefined)}>{labels.closePreview}</button>
          <ProtectedImage gateway={gateway} descriptor={previewResource} alt={asset?.displayName ?? asset?.model ?? labels.preview} />
        </div>
      ) : null}
    </div>
  );
}

export function LibraryWorkspace({
  gateway,
  view,
  providers
}: {
  readonly gateway: StudioGateway;
  readonly view: LibraryView;
  readonly providers: readonly ProviderProfileDescriptor[];
  readonly onCreationHandoff?: (handoff: LibraryCreationHandoff) => void;
}) {
  void view;
  const libraryView: LibraryView = "library";
  const { language } = useI18n();
  const labels = copy[language];
  const initialFilters = useMemo(() => createLibraryFilters(libraryView), []);
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
  const [pageBusy, setPageBusy] = useState(false);
  const [detailState, setDetailState] = useState<AssetDetailState>({ status: "idle" });
  const [relationshipResources, setRelationshipResources] = useState<
    readonly RelationshipResourceState[]
  >([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | undefined>();
  const [locations, setLocations] = useState<ReadonlyArray<NonNullable<RoutegoManageLibraryResult["locations"]>[number]>>([]);
  const [destinationLocationId, setDestinationLocationId] = useState("");
  const [editingAssetId, setEditingAssetId] = useState<string | undefined>();
  const [markState, setMarkState] = useState<{
    readonly known: boolean;
    readonly currentMarkRecordId?: string | undefined;
  }>({ known: false });
  const searchRequestRef = useRef(0);
  const cursor = currentLibraryCursor(page);

  useEffect(() => {
    let active = true;
    setFolderState({ status: "loading" });
    void gateway
      .invoke("listFolders", { includeDeleted: false })
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
  }, [folderRevision, gateway, labels.folderFailure]);

  const refreshLocations = useCallback(async () => {
    const result = await gateway.invoke("manageLibrary", { action: "list-locations" });
    setLocations(result.locations ?? []);
  }, [gateway]);

  useEffect(() => { void refreshLocations().catch(() => undefined); }, [refreshLocations]);

  useEffect(() => {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    let input;
    try {
      input = buildLibrarySearchInput(appliedFilters, libraryView, cursor);
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
  }, [appliedFilters, cursor, gateway, labels.searchFailure, searchRevision]);

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
      buildLibrarySearchInput(filters, libraryView);
      setFilterErrors({});
      setAppliedFilters(filters);
      setPage(initialLibraryPage());
    } catch (error) {
      if (error instanceof LibraryQueryError) {
        setFilterErrors(error.fields);
        setSearchState({ status: "failure", safeMessage: error.message });
      }
    }
  }, [filters]);

  const resetFilters = useCallback(() => {
    const next = createLibraryFilters(libraryView);
    setFilters(next);
    setAppliedFilters(next);
    setFilterErrors({});
    setPage(initialLibraryPage());
  }, []);

  const selectPage = useCallback(async (targetIndex: number) => {
    if (targetIndex < 0 || targetIndex === page.index || pageBusy) return;
    setPageBusy(true);
    try {
      let cursors = [...page.cursors];
      while (cursors.length <= targetIndex) {
        const result = await gateway.invoke(
          "searchStudioLibrary",
          buildLibrarySearchInput(appliedFilters, libraryView, cursors[cursors.length - 1])
        );
        if (result.nextCursor === undefined) break;
        cursors = [...cursors, result.nextCursor];
      }
      if (cursors[targetIndex] !== undefined || targetIndex === 0) {
        setPage({ cursors, index: targetIndex });
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : labels.searchFailure);
    } finally {
      setPageBusy(false);
    }
  }, [appliedFilters, gateway, labels.searchFailure, libraryView, page, pageBusy]);

  const selectFolder = useCallback(
    (folderId: string | undefined) => {
      const next = { ...filters, folderId };
      setFilters(next);
      setAppliedFilters(next);
      setPage(initialLibraryPage());
    },
    [filters]
  );

  const copyGenerationInfo = useCallback(
    async (asset: LibraryAssetDetail) => {
      setActionBusy(true);
      setActionMessage(undefined);
      try {
        const result = await invokeBrowserSafeLibraryAction<CopyGenerationInfoResult>(
          gateway,
          "/api/v1/library/copy-generation-info",
          createCopyGenerationInfoRequest(asset.id)
        );
        const clipboardText = copiedGenerationInformation(result);
        if (navigator.clipboard === undefined) throw new Error("Clipboard is unavailable.");
        await navigator.clipboard.writeText(clipboardText);
        setActionMessage(language === "zh" ? "生成信息已复制。" : "Generation information copied.");
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : labels.handoffFailure);
      } finally {
        setActionBusy(false);
      }
    },
    [gateway, labels.handoffFailure, language]
  );

  const markImage = useCallback(
    async (asset: LibraryAssetDetail) => {
      setActionBusy(true);
      setActionMessage(undefined);
      try {
        const result = await invokeBrowserSafeLibraryAction<MarkImageResult>(
          gateway,
          "/api/v1/library/mark",
          createMarkImageRequest(asset.id)
        );
        const nextMarkId = nextCurrentMarkRecordId(result);
        setMarkState({ known: true, currentMarkRecordId: nextMarkId });
        setActionMessage(
          nextMarkId === undefined
            ? language === "zh" ? "图片标记已取消。" : "Image mark cleared."
            : language === "zh" ? "图片已标记。" : "Image marked."
        );
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : labels.handoffFailure);
      } finally {
        setActionBusy(false);
      }
    },
    [gateway, labels.handoffFailure, language]
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

  const addLocation = useCallback(async () => {
    setActionBusy(true);
    try {
      const picked = await gateway.selectLibraryDirectory();
      if (!picked.selected || picked.result === undefined) return;
      const result = picked.result;
      setLocations(result.locations ?? []);
      refreshLibraryState();
      setActionMessage(language === "zh" ? "图库文件夹已读取。" : "Library folder loaded.");
    } catch (error) { setActionMessage(error instanceof Error ? error.message : labels.searchFailure); }
    finally { setActionBusy(false); }
  }, [gateway, labels.searchFailure, language, refreshLibraryState]);

  const moveSelected = useCallback(async () => {
    if (destinationLocationId === "" || selectedAssetIds.length === 0) return;
    setActionBusy(true);
    try {
      const result = await gateway.invoke("manageLibrary", { action: "move-assets", assetIds: [...selectedAssetIds], destinationLocationId });
      setSelectedAssetIds((current) => current.filter((id) => !result.affectedAssetIds.includes(id)));
      refreshLibraryState();
      void refreshLocations();
      setActionMessage(language === "zh" ? `已移动 ${result.affectedAssetIds.length} 张图片。` : `${result.affectedAssetIds.length} images moved.`);
    } catch (error) { setActionMessage(error instanceof Error ? error.message : labels.searchFailure); }
    finally { setActionBusy(false); }
  }, [destinationLocationId, gateway, labels.searchFailure, language, refreshLibraryState, refreshLocations, selectedAssetIds]);

  const deleteSelected = useCallback(async () => {
    if (selectedAssetIds.length === 0 || !window.confirm(labels.deleteConfirm)) return;
    setActionBusy(true);
    try {
      const result = await gateway.invoke("manageLibrary", { action: "delete-assets", assetIds: [...selectedAssetIds], confirmDelete: true });
      setSelectedAssetIds((current) => current.filter((id) => !result.affectedAssetIds.includes(id)));
      if (selectedAssetId && result.affectedAssetIds.includes(selectedAssetId)) setSelectedAssetId(undefined);
      refreshLibraryState();
      void refreshLocations();
      setActionMessage(language === "zh" ? `已删除 ${result.affectedAssetIds.length} 张图片。` : `${result.affectedAssetIds.length} images deleted.`);
    } catch (error) { setActionMessage(error instanceof Error ? error.message : labels.searchFailure); }
    finally { setActionBusy(false); }
  }, [gateway, labels.deleteConfirm, labels.searchFailure, language, refreshLibraryState, refreshLocations, selectedAssetId, selectedAssetIds]);

  const renameAsset = useCallback(async (assetId: string, name: string) => {
    const trimmed = name.trim();
    setEditingAssetId(undefined);
    if (trimmed === "") return;
    try {
      await gateway.invoke("manageLibrary", { action: "rename-asset", assetId, name: trimmed });
      refreshLibraryState();
    } catch (error) { setActionMessage(error instanceof Error ? error.message : labels.searchFailure); }
  }, [gateway, labels.searchFailure, refreshLibraryState]);

  const handleMutationResult = useCallback(
    (result: ExecuteLibraryMutationResult) => {
      setSelectedAssetIds((current) => remainingSelectedAssetIds(current, result));
      void selectedAssetId;
    },
    [selectedAssetId]
  );

  const items = searchState.status === "ready" ? searchState.items : [];
  const listedCurrentMarkRecordId = items.find((item) => item.currentMark)?.assetId;
  const currentMarkRecordId = markState.known
    ? markState.currentMarkRecordId
    : listedCurrentMarkRecordId;
  const currentPageIds = items.map((item) => item.assetId);
  const allCurrentPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((assetId) => selectedAssetIds.includes(assetId));
  const total = searchState.status === "ready" || searchState.status === "empty"
    ? searchState.total
    : undefined;
  const totalPages = total === undefined ? page.index + (searchState.status === "ready" && searchState.nextCursor !== undefined ? 2 : 1) : Math.max(1, Math.ceil(total / appliedFilters.limit));
  const pageNumbers = paginationPageNumbers(page.index + 1, totalPages);
  const selectionMode = selectedAssetIds.length > 0;
  const currentFolderName = filters.folderId === undefined
    ? labels.allFolders
    : folderState.status === "ready"
      ? folderState.folders.find((folder) => folder.id === filters.folderId)?.name ?? labels.allFolders
      : labels.allFolders;
  return (
    <section className="library-workspace library-workspace--library">
      <header className="library-workspace__header">
        <div>
          <p>{labels.libraryEyebrow}</p>
          <h1 tabIndex={-1}>{labels.libraryTitle}</h1>
        </div>
      </header>

      <div className="library-workspace__tools">
        <section className="library-locations" aria-label={labels.locations}>
          <label><span>{labels.locations}</span><select value={filters.folderId ?? ""} onChange={(event) => selectFolder(event.currentTarget.value || undefined)}>
            <option value="">{labels.allFolders}</option>
            {locations.filter((location) => !location.isDefault && location.folderId !== undefined).map((location) => <option key={location.id} value={location.folderId}>{location.name} · {location.assetCount}</option>)}
          </select></label>
          <button type="button" disabled={actionBusy} onClick={() => void addLocation()}>{labels.addLocation}</button>
          <p className="library-locations__current"><span>{labels.currentFolder}</span><strong>{currentFolderName}</strong></p>
        </section>
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
          labels={labels}
          language={language}
          providers={providers}
          errors={filterErrors}
          onChange={setFilters}
          onSubmit={applyFilters}
          onReset={resetFilters}
        />
      </div>

      <div className="library-workspace__summary">
        <div className="library-workspace__counts">
          {total === undefined ? null : <span>{labels.total} {total}</span>}
          <span>{labels.selectedCount} {selectedAssetIds.length}</span>
        </div>
        <button
          type="button"
          className="library-workspace__clear-selection"
          disabled={!selectionMode}
          onClick={() => setSelectedAssetIds([])}
        >
          {labels.cancelSelection}
        </button>
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
        <select aria-label={labels.moveTo} value={destinationLocationId} onChange={(event) => setDestinationLocationId(event.currentTarget.value)}>
          <option value="">{labels.moveTo}</option>
          {locations.filter((location) => !location.isDefault).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select>
        <button type="button" disabled={actionBusy || selectedAssetIds.length === 0 || destinationLocationId === ""} onClick={() => void moveSelected()}>{labels.moveSelected}</button>
        <button type="button" className="library-workspace__delete" disabled={actionBusy || selectedAssetIds.length === 0} onClick={() => void deleteSelected()}>{labels.deleteSelected}</button>
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
        <>
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
                selectionMode={selectionMode}
                onCheckedChange={(checked) =>
                  setSelectedAssetIds((current) =>
                    checked
                      ? [...new Set([...current, item.assetId])]
                      : current.filter((assetId) => assetId !== item.assetId)
                  )
                }
                editingName={editingAssetId === item.assetId}
                onStartRename={() => setEditingAssetId(item.assetId)}
                onRename={(name) => void renameAsset(item.assetId, name)}
                onOpen={() => setSelectedAssetId(item.assetId)}
              />
            ))}
          </div>
          <nav className="library-pagination" aria-label={`${labels.page} ${page.index + 1}`}>
          <button
            className="library-pagination__arrow"
            type="button"
            aria-label={labels.previous}
            title={labels.previous}
            disabled={page.index === 0}
            onClick={() => setPage((current) => retreatLibraryPage(current))}
          >
            <span aria-hidden="true">←</span>
          </button>
          {pageNumbers.map((entry, index) => entry === "ellipsis" ? (
            <span key={`${entry}-${index}`} className="library-pagination__ellipsis" aria-hidden="true">…</span>
          ) : (
            <button
              key={entry}
              type="button"
              className="library-pagination__page"
              aria-current={entry === page.index + 1 ? "page" : undefined}
              disabled={pageBusy || entry === page.index + 1}
              onClick={() => void selectPage(entry - 1)}
            >
              {entry}
            </button>
          ))}
          <button
            className="library-pagination__arrow"
            type="button"
            aria-label={labels.next}
            title={labels.next}
            disabled={searchState.nextCursor === undefined}
            onClick={() =>
              setPage((current) => advanceLibraryPage(current, searchState.nextCursor))
            }
          >
            <span aria-hidden="true">→</span>
          </button>
          </nav>
        </>
      )}

      <DetailDrawer
        gateway={gateway}
        state={detailState}
        resources={relationshipResources}
        labels={labels}
        language={language}
        actionMessage={actionMessage}
        actionBusy={actionBusy}
        onClose={() => setSelectedAssetId(undefined)}
        currentMarkRecordId={currentMarkRecordId}
        onCopyGenerationInfo={(asset) => void copyGenerationInfo(asset)}
        onMarkImage={(asset) => void markImage(asset)}
        onDownload={(asset) => void download(asset)}
      />
    </section>
  );
}
