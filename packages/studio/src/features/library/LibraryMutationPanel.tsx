import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import type {
  ExecuteLibraryMutationResult,
  LibraryFolderDescriptor,
  LibraryMutationRequest,
  PreflightLibraryMutationResult
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import {
  createUploadItem,
  discardUploadLifecycle,
  performUploadLifecycle,
  retryUploadLifecycle,
  type UploadLifecycleItem
} from "../creation";
import { useI18n } from "../../i18n";
import { fetchProtectedResourceDownload, triggerLibraryDownload } from "./download";
import {
  buildAssetLibraryMutation,
  buildZipImportMutation,
  executionConfirmations,
  moveFolderIds,
  mutationResultCounts,
  type AssetLibraryMutationAction
} from "./mutations";
import type { LibraryView } from "./types";

const copy = {
  zh: {
    eyebrow: "SAFE MUTATION / 04",
    title: "文件夹与安全变更台",
    body: "所有资产变更先预检，再按逐项结果执行；ZIP 字节只走受保护上传通道。",
    selected: "已选择",
    assets: "项",
    createFolder: "创建档案夹",
    folderName: "档案夹名称",
    create: "创建",
    renameFolder: "重命名档案夹",
    chooseFolder: "选择档案夹",
    rename: "重命名",
    ordering: "完整排序",
    moveUp: "上移",
    moveDown: "下移",
    saveOrder: "保存完整顺序",
    folderTargets: "变更目标档案夹",
    assign: "分配到档案夹",
    remove: "从档案夹移除",
    exportZip: "导出 ZIP",
    importZip: "导入 ZIP",
    chooseZip: "选择 ZIP 文件",
    retryUpload: "重新预留并上传",
    removeUpload: "移除上传",
    uploadReady: "ZIP 已完成上传，可开始导入预检。",
    uploadConsumed: "ZIP 已单次使用；再次导入必须重新上传。",
    preflight: "预检",
    preflightStatus: "预检状态",
    eligible: "可执行",
    blocked: "已阻止",
    exactConfirmation: "精确确认文本",
    execute: "执行已预检变更",
    refreshPreflight: "重新预检",
    result: "逐项执行结果",
    success: "成功",
    failed: "失败",
    skipped: "跳过",
    busy: "正在处理…",
    noFolders: "当前没有可用档案夹。",
    selectAssets: "请先在当前图库页选择项目。",
    imported: "已导入",
    skippedCount: "已跳过"
  },
  en: {
    eyebrow: "SAFE MUTATION / 04",
    title: "Folders & guarded mutations",
    body: "Every asset change is preflighted and executed with per-item outcomes; ZIP bytes use only the protected upload channel.",
    selected: "Selected",
    assets: "items",
    createFolder: "Create folder",
    folderName: "Folder name",
    create: "Create",
    renameFolder: "Rename folder",
    chooseFolder: "Choose folder",
    rename: "Rename",
    ordering: "Complete order",
    moveUp: "Move up",
    moveDown: "Move down",
    saveOrder: "Save complete order",
    folderTargets: "Target folders",
    assign: "Assign folders",
    remove: "Remove folders",
    exportZip: "Export ZIP",
    importZip: "Import ZIP",
    chooseZip: "Choose ZIP file",
    retryUpload: "Reserve and upload again",
    removeUpload: "Remove upload",
    uploadReady: "ZIP upload is finalized and ready for import preflight.",
    uploadConsumed: "The ZIP was consumed once; upload it again to import again.",
    preflight: "Preflight",
    preflightStatus: "Preflight status",
    eligible: "Eligible",
    blocked: "Blocked",
    exactConfirmation: "Exact confirmation text",
    execute: "Execute preflighted change",
    refreshPreflight: "Run preflight again",
    result: "Per-item execution result",
    success: "Succeeded",
    failed: "Failed",
    skipped: "Skipped",
    busy: "Working…",
    noFolders: "No active folders are available.",
    selectAssets: "Select items on the current Library page first.",
    imported: "Imported",
    skippedCount: "Skipped"
  }
} as const;

export interface LibraryMutationPanelProps {
  readonly gateway: StudioGateway;
  readonly view: LibraryView;
  readonly folders: readonly LibraryFolderDescriptor[];
  readonly selectedAssetIds: readonly string[];
  readonly onFoldersChange: (folders: readonly LibraryFolderDescriptor[]) => void;
  readonly onMutationResult: (result: ExecuteLibraryMutationResult) => void;
  readonly onRefresh: () => void;
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The local Library operation failed safely.";
}

export function LibraryMutationPanel({
  gateway,
  view,
  folders,
  selectedAssetIds,
  onFoldersChange,
  onMutationResult,
  onRefresh
}: LibraryMutationPanelProps) {
  const { language } = useI18n();
  const labels = copy[language];
  const activeFolders = useMemo(
    () => folders.filter((folder) => folder.state === "active"),
    [folders]
  );
  const [folderOrder, setFolderOrder] = useState<readonly string[]>(
    activeFolders.map((folder) => folder.id)
  );
  const [folderName, setFolderName] = useState("");
  const [renameFolderId, setRenameFolderId] = useState("");
  const [renameName, setRenameName] = useState("");
  const [targetFolderIds, setTargetFolderIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [mutation, setMutation] = useState<LibraryMutationRequest>();
  const [preflight, setPreflight] = useState<PreflightLibraryMutationResult>();
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<ExecuteLibraryMutationResult>();
  const [zipUpload, setZipUpload] = useState<UploadLifecycleItem>();
  const [zipConsumed, setZipConsumed] = useState(false);

  useEffect(() => {
    setFolderOrder(activeFolders.map((folder) => folder.id));
    setTargetFolderIds((current) =>
      current.filter((folderId) => activeFolders.some((folder) => folder.id === folderId))
    );
    setRenameFolderId((current) =>
      activeFolders.some((folder) => folder.id === current) ? current : ""
    );
  }, [activeFolders]);

  const clearWorkflow = () => {
    setMutation(undefined);
    setPreflight(undefined);
    setConfirmation("");
    setResult(undefined);
  };

  const runFolderAction = async (action: "create-folder" | "rename-folder") => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const output =
        action === "create-folder"
          ? await gateway.invoke("manageLibrary", { action, name: folderName.trim() })
          : await gateway.invoke("manageLibrary", {
              action,
              folderId: renameFolderId,
              name: renameName.trim()
            });
      setMessage(`${output.action}: ${output.affectedFolderIds.join(", ")}`);
      if (action === "create-folder") setFolderName("");
      else setRenameName("");
      onRefresh();
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveFolderOrder = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const output = await gateway.invoke("reorderFolders", { folderIds: [...folderOrder] });
      if (output.status !== "succeeded") {
        throw new Error(output.error?.safeMessage ?? "Folder order was not saved.");
      }
      onFoldersChange(output.folders);
      setMessage(`${labels.ordering}: ${output.folders.length}`);
      onRefresh();
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const preflightMutation = async (nextMutation: LibraryMutationRequest) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    setResult(undefined);
    setConfirmation("");
    try {
      const output = await gateway.invoke("preflightLibraryMutation", {
        mutation: nextMutation
      });
      setMutation(nextMutation);
      setPreflight(output);
    } catch (caught) {
      setMutation(nextMutation);
      setPreflight(undefined);
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const startAssetMutation = async (action: AssetLibraryMutationAction) => {
    try {
      await preflightMutation(
        buildAssetLibraryMutation(action, selectedAssetIds, targetFolderIds)
      );
    } catch (caught) {
      setError(safeMessage(caught));
    }
  };

  const executeMutation = async () => {
    if (preflight === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const confirmations = executionConfirmations(preflight, confirmation);
      const output = await gateway.invoke("executeLibraryMutation", {
        preflightId: preflight.preflightId,
        action: preflight.action,
        confirmations
      });
      setResult(output);
      if (output.action === "import-zip" && output.status === "succeeded") {
        setZipConsumed(true);
      }
      onMutationResult(output);
      onRefresh();
      if (output.action === "export-zip" && output.outputResource !== undefined) {
        try {
          triggerLibraryDownload(
            await fetchProtectedResourceDownload(
              gateway,
              output.outputResource,
              `routego-library-${output.preflightId}.zip`
            )
          );
        } catch (downloadError) {
          setError(safeMessage(downloadError));
        }
      }
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const chooseZip = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    setBusy(true);
    setError(undefined);
    clearWorkflow();
    try {
      if (zipUpload !== undefined && !zipConsumed) {
        await discardUploadLifecycle(gateway, zipUpload, setZipUpload).catch(() => undefined);
      }
      const next = createUploadItem("zip-import", { name: file.name, blob: file });
      setZipUpload(next);
      setZipConsumed(false);
      await performUploadLifecycle(gateway, next, setZipUpload);
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const retryZip = async () => {
    if (zipUpload === undefined || zipConsumed) return;
    setBusy(true);
    setError(undefined);
    clearWorkflow();
    try {
      await retryUploadLifecycle(gateway, zipUpload, setZipUpload);
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const removeZip = async () => {
    if (zipUpload === undefined) return;
    setBusy(true);
    setError(undefined);
    clearWorkflow();
    try {
      if (!zipConsumed) {
        await discardUploadLifecycle(gateway, zipUpload, setZipUpload);
      }
      setZipUpload(undefined);
      setZipConsumed(false);
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const preflightZip = async () => {
    try {
      await preflightMutation(
        buildZipImportMutation(
          zipUpload?.status === "ready" ? zipUpload.uploadResourceId : undefined,
          zipConsumed
        )
      );
    } catch (caught) {
      setError(safeMessage(caught));
    }
  };

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runFolderAction("create-folder");
  };
  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runFolderAction("rename-folder");
  };
  const requiredConfirmation = preflight?.requiredConfirmations[0];
  const counts = result === undefined ? undefined : mutationResultCounts(result);

  return (
    <section className="library-mutation-panel" aria-labelledby={`library-mutation-${view}`}>
      <header>
        <p>{labels.eyebrow}</p>
        <h2 id={`library-mutation-${view}`}>{labels.title}</h2>
        <span>{labels.body}</span>
        <strong>{labels.selected}: {selectedAssetIds.length} {labels.assets}</strong>
      </header>

      {view === "library" ? (
        <div className="library-mutation-panel__folders">
          <form onSubmit={submitCreate}>
            <h3>{labels.createFolder}</h3>
            <label>
              <span>{labels.folderName}</span>
              <input required maxLength={200} value={folderName} onChange={(event) => setFolderName(event.target.value)} />
            </label>
            <button disabled={busy || folderName.trim() === ""} type="submit">{labels.create}</button>
          </form>

          <form onSubmit={submitRename}>
            <h3>{labels.renameFolder}</h3>
            <label>
              <span>{labels.chooseFolder}</span>
              <select required value={renameFolderId} onChange={(event) => setRenameFolderId(event.target.value)}>
                <option value="">—</option>
                {activeFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            <label>
              <span>{labels.folderName}</span>
              <input required maxLength={200} value={renameName} onChange={(event) => setRenameName(event.target.value)} />
            </label>
            <button disabled={busy || renameFolderId === "" || renameName.trim() === ""} type="submit">{labels.rename}</button>
          </form>

          <section className="library-folder-order" aria-labelledby={`folder-order-${view}`}>
            <h3 id={`folder-order-${view}`}>{labels.ordering}</h3>
            {folderOrder.length === 0 ? <p>{labels.noFolders}</p> : (
              <ol>
                {folderOrder.map((folderId, index) => {
                  const folder = activeFolders.find((candidate) => candidate.id === folderId);
                  return (
                    <li key={folderId}>
                      <span>{folder?.name ?? folderId}</span>
                      <div>
                        <button type="button" disabled={busy || index === 0} aria-label={`${labels.moveUp}: ${folder?.name ?? folderId}`} onClick={() => setFolderOrder(moveFolderIds(folderOrder, folderId, -1))}>↑</button>
                        <button type="button" disabled={busy || index === folderOrder.length - 1} aria-label={`${labels.moveDown}: ${folder?.name ?? folderId}`} onClick={() => setFolderOrder(moveFolderIds(folderOrder, folderId, 1))}>↓</button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <button type="button" disabled={busy || folderOrder.length === 0} onClick={() => void saveFolderOrder()}>{labels.saveOrder}</button>
          </section>
        </div>
      ) : null}

      <div className="library-mutation-panel__actions">
        {view === "library" ? (
          <fieldset>
            <legend>{labels.folderTargets}</legend>
            {activeFolders.length === 0 ? <p>{labels.noFolders}</p> : activeFolders.map((folder) => (
              <label key={folder.id}>
                <input
                  type="checkbox"
                  checked={targetFolderIds.includes(folder.id)}
                  onChange={() => setTargetFolderIds((current) => current.includes(folder.id) ? current.filter((id) => id !== folder.id) : [...current, folder.id])}
                />
                {folder.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="library-mutation-panel__buttons">
          <>
            <button type="button" disabled={busy || selectedAssetIds.length === 0 || targetFolderIds.length === 0} onClick={() => void startAssetMutation("assign-folders")}>{labels.assign}</button>
            <button type="button" disabled={busy || selectedAssetIds.length === 0 || targetFolderIds.length === 0} onClick={() => void startAssetMutation("remove-folders")}>{labels.remove}</button>
          </>
          <button type="button" disabled={busy || selectedAssetIds.length === 0} onClick={() => void startAssetMutation("export-zip")}>{labels.exportZip}</button>
        </div>
        {selectedAssetIds.length === 0 ? <p>{labels.selectAssets}</p> : null}
      </div>

      {view === "library" ? <section className="library-zip-import" aria-labelledby={`zip-import-${view}`}>
        <h3 id={`zip-import-${view}`}>{labels.importZip}</h3>
        <label className="library-zip-import__picker">
          <span>{labels.chooseZip}</span>
          <input type="file" accept="application/zip,.zip" disabled={busy} onChange={(event) => void chooseZip(event)} />
        </label>
        {zipUpload === undefined ? null : (
          <div className="library-zip-import__state" data-state={zipConsumed ? "consumed" : zipUpload.status}>
            <strong>{zipUpload.source.name}</strong>
            <span>{zipConsumed ? labels.uploadConsumed : zipUpload.status === "ready" ? labels.uploadReady : zipUpload.safeMessage ?? zipUpload.status}</span>
            <div>
              {zipUpload.status === "failed" || zipUpload.status === "expired" ? <button type="button" disabled={busy || zipConsumed} onClick={() => void retryZip()}>{labels.retryUpload}</button> : null}
              <button type="button" disabled={busy} onClick={() => void removeZip()}>{labels.removeUpload}</button>
              <button type="button" disabled={busy || zipUpload.status !== "ready" || zipConsumed} onClick={() => void preflightZip()}>{labels.preflight}</button>
            </div>
          </div>
        )}
      </section> : null}

      {preflight === undefined ? null : (
        <section className="library-preflight" data-state={preflight.status}>
          <header>
            <h3>{labels.preflightStatus}: {preflight.status}</h3>
            <span>{preflight.action}</span>
          </header>
          {preflight.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          <ul>
            {preflight.items.map((item) => (
              <li key={item.targetId} data-state={item.eligible ? "eligible" : "blocked"}>
                <strong>{item.targetId}</strong>
                <span>{item.eligible ? labels.eligible : labels.blocked}</span>
                {item.error ? <small>{item.error.safeMessage}</small> : null}
                {item.warnings.map((warning) => <small key={warning}>{warning}</small>)}
              </li>
            ))}
          </ul>
          {requiredConfirmation === undefined ? null : (
            <label>
              <span>{labels.exactConfirmation}: <code>{requiredConfirmation}</code></span>
              <input value={confirmation} autoComplete="off" spellCheck={false} onChange={(event) => setConfirmation(event.target.value)} />
            </label>
          )}
          <div className="library-preflight__actions">
            <button type="button" disabled={busy || preflight.status === "blocked" || (requiredConfirmation !== undefined && confirmation !== requiredConfirmation)} onClick={() => void executeMutation()}>{labels.execute}</button>
            <button type="button" disabled={busy || mutation === undefined} onClick={() => mutation && void preflightMutation(mutation)}>{labels.refreshPreflight}</button>
          </div>
        </section>
      )}

      {result === undefined || counts === undefined ? null : (
        <section className="library-mutation-result" data-state={result.status} aria-live="polite">
          <h3>{labels.result}: {result.status}</h3>
          <p>{labels.success}: {counts.succeeded} · {labels.failed}: {counts.failed} · {labels.skipped}: {counts.skipped}</p>
          {result.importedCount === undefined ? null : <p>{labels.imported}: {result.importedCount} · {labels.skippedCount}: {result.skippedCount ?? 0}</p>}
          <ul>
            {result.items.map((item) => (
              <li key={item.targetId} data-state={item.status}>
                <strong>{item.targetId}</strong>
                <span>{item.status}</span>
                {item.error ? <small>{item.error.safeMessage}</small> : null}
                {item.warnings.map((warning) => <small key={warning}>{warning}</small>)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {busy ? <p className="library-mutation-panel__busy" role="status">{labels.busy}</p> : null}
      {message ? <p className="library-mutation-panel__message" role="status">{message}</p> : null}
      {error ? <p className="library-mutation-panel__error" role="alert">{error}</p> : null}
    </section>
  );
}
