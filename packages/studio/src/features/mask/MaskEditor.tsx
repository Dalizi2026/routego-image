import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  type WheelEvent as ReactWheelEvent
} from "react";

import type {
  BrowserResourceDescriptor,
  UploadResourceDescriptor
} from "@routego-image/contracts";

import {
  createProtectedObjectUrl,
  type ProtectedObjectUrl,
  type StudioGateway
} from "../../api";
import {
  clearMaskBitmap,
  cloneMaskBitmap,
  createEmptyMaskBitmap,
  isMaskBitmapEmpty,
  maskBitmapsEqual,
  paintMaskSegment,
  type MaskBitmap,
  type MaskTool
} from "./bitmap";
import {
  canRedoMask,
  canUndoMask,
  commitMaskHistory,
  createMaskHistory,
  redoMaskHistory,
  undoMaskHistory,
  type MaskHistory
} from "./history";
import { encodeMaskPng, writeMaskBitmapToCanvas } from "./png";
import { resolveMaskShortcut } from "./shortcuts";
import { maskCloseDisposition } from "./state";
import {
  boundMaskViewport,
  fitMaskViewport,
  isImagePointInside,
  panMaskViewport,
  screenPointToImage,
  wheelMaskZoom,
  zoomMaskViewportAt,
  type MaskPoint,
  type MaskSize,
  type MaskViewport
} from "./viewport";
import {
  bindFinalizedMaskUpload,
  type MaskPngUploadRequest,
  type MaskUploadLocator
} from "./upload";

import "./mask-editor.css";

export type MaskCapabilityState = "unknown" | "supported" | "unsupported" | "degraded";
export type MaskEditorLanguage = "zh-CN" | "en";

export interface MaskEditorProps {
  readonly gateway: Pick<StudioGateway, "fetchProtectedObjectUrl">;
  readonly target?: BrowserResourceDescriptor;
  readonly targetBlob?: Blob;
  readonly targetSize?: MaskSize;
  readonly targetKey?: string;
  readonly targetAlt: string;
  readonly capability: MaskCapabilityState;
  readonly language?: MaskEditorLanguage;
  readonly initialMask?: MaskBitmap;
  readonly historyLimit?: number;
  readonly onUploadMask: (request: MaskPngUploadRequest) => Promise<UploadResourceDescriptor>;
  readonly onSave: (locator: MaskUploadLocator) => void;
  readonly onClose: () => void;
}

type TargetState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly resource: ProtectedObjectUrl }
  | { readonly status: "failure" };

type SaveState = "idle" | "encoding" | "uploading" | "success" | "failure" | "empty";

type ActiveGesture =
  | {
      kind: "draw";
      pointerId: number;
      lastImagePoint: MaskPoint;
      changed: boolean;
    }
  | {
      kind: "pan";
      pointerId: number;
      lastScreenPoint: MaskPoint;
    };

type MaskSetup =
  | {
      readonly status: "ready";
      readonly target?: BrowserResourceDescriptor;
      readonly targetBlob?: Blob;
      readonly imageSize: MaskSize;
      readonly initial: MaskBitmap;
      readonly key: string;
    }
  | { readonly status: "failure"; readonly key: string };

const text = {
  "zh-CN": {
    title: "遮罩暗房",
    eyebrow: "TARGET SLOT 00 / ALPHA PLATE",
    close: "关闭编辑器",
    save: "保存遮罩",
    saving: "正在编码",
    uploading: "正在上传",
    saved: "遮罩已就绪",
    unavailable: "当前中转未确认支持",
    unavailableDetail: "遮罩编辑保持停用，不会伪装为模型编辑成功。",
    missingTarget: "缺少有效的受保护目标图，无法创建遮罩。",
    setupFailure: "目标图尺寸无法建立安全的遮罩画布。",
    loading: "正在装载受保护目标图…",
    resourceFailure: "目标图无法通过受保护资源边界加载。",
    brush: "画笔 B",
    eraser: "橡皮擦 E",
    pan: "平移 H",
    undo: "撤销",
    redo: "重做",
    clear: "清空",
    fit: "适合画布 0",
    zoomIn: "放大",
    zoomOut: "缩小",
    brushSize: "笔刷大小",
    overlay: "覆盖预览",
    overlayVisible: "显示覆盖层",
    overlayOpacity: "覆盖层不透明度",
    canvasLabel: "目标图与可编辑遮罩覆盖层",
    emptyMask: "遮罩为空。请先绘制需要编辑的区域。",
    saveFailure: "遮罩编码或上传失败，当前内容仍保留。",
    degraded: "当前使用已确认的降级遮罩路径。保存前请确认语义限制。",
    shortcuts: "B 画笔 · E 橡皮擦 · H 平移 · [ ] 笔刷 · Ctrl/⌘ Z 撤销",
    dirty: "有未保存更改",
    clean: "遮罩尚未更改",
    discardTitle: "放弃未保存遮罩？",
    discardBody: "关闭会丢弃当前遮罩笔画，源图不会被修改。",
    keepEditing: "继续编辑",
    discard: "放弃并关闭",
    zoom: "缩放"
  },
  en: {
    title: "Mask darkroom",
    eyebrow: "TARGET SLOT 00 / ALPHA PLATE",
    close: "Close editor",
    save: "Save mask",
    saving: "Encoding",
    uploading: "Uploading",
    saved: "Mask ready",
    unavailable: "Current relay support is unconfirmed",
    unavailableDetail: "Mask editing stays disabled and will not imitate a successful model edit.",
    missingTarget: "A valid protected target image is required to create a mask.",
    setupFailure: "The target dimensions cannot create a safe mask canvas.",
    loading: "Loading protected target…",
    resourceFailure: "The target could not be loaded through the protected resource boundary.",
    brush: "Brush B",
    eraser: "Eraser E",
    pan: "Pan H",
    undo: "Undo",
    redo: "Redo",
    clear: "Clear",
    fit: "Fit canvas 0",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    brushSize: "Brush size",
    overlay: "Overlay preview",
    overlayVisible: "Show overlay",
    overlayOpacity: "Overlay opacity",
    canvasLabel: "Target image with editable mask overlay",
    emptyMask: "The mask is empty. Paint the area that may be edited first.",
    saveFailure: "Mask encoding or upload failed. Your current mask is preserved.",
    degraded: "A confirmed degraded mask path is active. Review its semantic limits before saving.",
    shortcuts: "B brush · E eraser · H pan · [ ] size · Ctrl/⌘ Z undo",
    dirty: "Unsaved changes",
    clean: "Mask unchanged",
    discardTitle: "Discard the unsaved mask?",
    discardBody: "Closing discards the current mask strokes. The source image remains unchanged.",
    keepEditing: "Keep editing",
    discard: "Discard and close",
    zoom: "Zoom"
  }
} as const;

function prepareMaskSetup(
  target: BrowserResourceDescriptor | undefined,
  targetBlob: Blob | undefined,
  targetSize: MaskSize | undefined,
  targetKey: string | undefined,
  initialMask: MaskBitmap | undefined
): MaskSetup {
  const key = targetKey ?? target?.resourceId ?? "missing-target";
  const resourceSize =
    target?.width === undefined || target.height === undefined
      ? undefined
      : { width: target.width, height: target.height };
  if (
    resourceSize !== undefined &&
    targetSize !== undefined &&
    (resourceSize.width !== targetSize.width || resourceSize.height !== targetSize.height)
  ) {
    return { status: "failure", key };
  }
  const imageSize = resourceSize ?? targetSize;
  const validResource = target !== undefined && target.mimeType.startsWith("image/");
  const validBlob =
    targetBlob !== undefined && targetBlob.size > 0 && targetBlob.type.startsWith("image/");
  if ((!validResource && !validBlob) || imageSize === undefined) {
    return { status: "failure", key };
  }
  try {
    const empty = createEmptyMaskBitmap(imageSize.width, imageSize.height);
    if (
      initialMask &&
      (initialMask.width !== imageSize.width || initialMask.height !== imageSize.height)
    ) {
      return { status: "failure", key };
    }
    return {
      status: "ready",
      ...(validResource ? { target } : {}),
      ...(validBlob ? { targetBlob } : {}),
      imageSize,
      initial: initialMask ? cloneMaskBitmap(initialMask) : empty,
      key: `${key}:${imageSize.width}x${imageSize.height}`
    };
  } catch {
    return { status: "failure", key };
  }
}

function eventPoint(event: ReactPointerEvent<HTMLElement> | ReactWheelEvent<HTMLElement>): MaskPoint {
  const rectangle = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
}

function editableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function clampBrushSize(size: number): number {
  return Math.max(1, Math.min(512, Math.round(size)));
}

export function MaskEditor({
  gateway,
  target,
  targetBlob,
  targetSize,
  targetKey,
  targetAlt,
  capability,
  language = "zh-CN",
  initialMask,
  historyLimit = 12,
  onUploadMask,
  onSave,
  onClose
}: MaskEditorProps) {
  const labels = text[language];
  const setup = useMemo(
    () => prepareMaskSetup(target, targetBlob, targetSize, targetKey, initialMask),
    [initialMask, target, targetBlob, targetKey, targetSize]
  );
  const initialBitmap = setup.status === "ready" ? setup.initial : createEmptyMaskBitmap(1, 1);
  const [history, setHistory] = useState<MaskHistory>(() =>
    createMaskHistory(initialBitmap, historyLimit)
  );
  const [baseline, setBaseline] = useState<MaskBitmap>(() => cloneMaskBitmap(initialBitmap));
  const [targetState, setTargetState] = useState<TargetState>({ status: "idle" });
  const [targetDecoded, setTargetDecoded] = useState(false);
  const [tool, setTool] = useState<MaskTool | "pan">("brush");
  const [brushSize, setBrushSize] = useState(48);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayOpacity, setOverlayOpacity] = useState(0.58);
  const [viewport, setViewport] = useState<MaskViewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [viewportSize, setViewportSize] = useState<MaskSize>({ width: 1, height: 1 });
  const [cursorPoint, setCursorPoint] = useState<MaskPoint | undefined>();
  const [draftRevision, setDraftRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirmClose, setConfirmClose] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<MaskBitmap | undefined>(undefined);
  const gestureRef = useRef<ActiveGesture | undefined>(undefined);
  const historyRef = useRef(history);
  const viewportRef = useRef(viewport);
  const fitInitializedRef = useRef(false);

  historyRef.current = history;
  viewportRef.current = viewport;
  const currentMask = draftRef.current ?? history.present;
  const dirty = !maskBitmapsEqual(currentMask, baseline);
  const capabilityReady = capability === "supported" || capability === "degraded";

  useEffect(() => {
    const next = setup.status === "ready" ? setup.initial : createEmptyMaskBitmap(1, 1);
    const nextHistory = createMaskHistory(next, historyLimit);
    draftRef.current = undefined;
    gestureRef.current = undefined;
    setHistory(nextHistory);
    setBaseline(cloneMaskBitmap(next));
    setSaveState("idle");
    setConfirmClose(false);
    fitInitializedRef.current = false;
    setDraftRevision((revision) => revision + 1);
  }, [historyLimit, setup.key]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!dirty || typeof window === "undefined") {
      return undefined;
    }
    const preventUnsafeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventUnsafeClose);
    return () => window.removeEventListener("beforeunload", preventUnsafeClose);
  }, [dirty]);

  useEffect(() => {
    if (!capabilityReady || setup.status !== "ready") {
      setTargetDecoded(false);
      setTargetState({ status: "idle" });
      return undefined;
    }
    let active = true;
    let objectUrl: ProtectedObjectUrl | undefined;
    setTargetDecoded(false);
    setTargetState({ status: "loading" });
    const resourcePromise =
      setup.target !== undefined
        ? gateway.fetchProtectedObjectUrl(setup.target)
        : Promise.resolve(createProtectedObjectUrl(setup.targetBlob!));
    void resourcePromise
      .then((resource) => {
        objectUrl = resource;
        if (active) {
          setTargetState({ status: "ready", resource });
        } else {
          resource.revoke();
        }
      })
      .catch(() => {
        if (active) {
          setTargetState({ status: "failure" });
        }
      });
    return () => {
      active = false;
      objectUrl?.revoke();
    };
  }, [capabilityReady, gateway, setup]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return undefined;
    }
    const measure = () => {
      const rectangle = stage.getBoundingClientRect();
      if (rectangle.width > 0 && rectangle.height > 0) {
        setViewportSize({ width: rectangle.width, height: rectangle.height });
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [setup.key]);

  useEffect(() => {
    if (setup.status !== "ready" || viewportSize.width <= 1 || viewportSize.height <= 1) {
      return;
    }
    if (!fitInitializedRef.current) {
      fitInitializedRef.current = true;
      setViewport(fitMaskViewport(setup.imageSize, viewportSize));
      return;
    }
    setViewport((current) => boundMaskViewport(current, setup.imageSize, viewportSize));
  }, [setup, viewportSize]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || setup.status !== "ready") {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    writeMaskBitmapToCanvas(context, draftRef.current ?? history.present);
  }, [draftRevision, history, setup]);

  function fitCanvas() {
    if (setup.status === "ready") {
      setViewport(fitMaskViewport(setup.imageSize, viewportSize));
    }
  }

  function changeZoom(multiplier: number) {
    if (setup.status !== "ready") {
      return;
    }
    const center = { x: viewportSize.width / 2, y: viewportSize.height / 2 };
    setViewport((current) =>
      zoomMaskViewportAt(
        current,
        center,
        current.scale * multiplier,
        setup.imageSize,
        viewportSize
      )
    );
  }

  function undo() {
    if (!gestureRef.current) {
      setHistory((current) => undoMaskHistory(current));
      setSaveState("idle");
    }
  }

  function redo() {
    if (!gestureRef.current) {
      setHistory((current) => redoMaskHistory(current));
      setSaveState("idle");
    }
  }

  function clear() {
    if (gestureRef.current) {
      return;
    }
    const next = cloneMaskBitmap(historyRef.current.present);
    if (clearMaskBitmap(next) > 0) {
      setHistory((current) => commitMaskHistory(current, next));
      setSaveState("idle");
    }
  }

  function beginGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      setup.status !== "ready" ||
      !capabilityReady ||
      targetState.status !== "ready" ||
      !targetDecoded ||
      (event.button !== 0 && event.button !== 1)
    ) {
      return;
    }
    event.preventDefault();
    const screenPoint = eventPoint(event);
    setCursorPoint(screenPoint);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "pan" || event.button === 1) {
      gestureRef.current = {
        kind: "pan",
        pointerId: event.pointerId,
        lastScreenPoint: screenPoint
      };
      return;
    }
    const imagePoint = screenPointToImage(screenPoint, viewportRef.current);
    if (!isImagePointInside(imagePoint, setup.imageSize)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const draft = cloneMaskBitmap(historyRef.current.present);
    const changed = paintMaskSegment(draft, imagePoint, imagePoint, brushSize, tool) > 0;
    draftRef.current = draft;
    gestureRef.current = {
      kind: "draw",
      pointerId: event.pointerId,
      lastImagePoint: imagePoint,
      changed
    };
    setSaveState("idle");
    setDraftRevision((revision) => revision + 1);
  }

  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const screenPoint = eventPoint(event);
    setCursorPoint(screenPoint);
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || setup.status !== "ready") {
      return;
    }
    event.preventDefault();
    if (gesture.kind === "pan") {
      const delta = {
        x: screenPoint.x - gesture.lastScreenPoint.x,
        y: screenPoint.y - gesture.lastScreenPoint.y
      };
      gesture.lastScreenPoint = screenPoint;
      setViewport((current) =>
        panMaskViewport(current, delta, setup.imageSize, viewportSize)
      );
      return;
    }
    const draft = draftRef.current;
    if (!draft || tool === "pan") {
      return;
    }
    const imagePoint = screenPointToImage(screenPoint, viewportRef.current);
    if (paintMaskSegment(draft, gesture.lastImagePoint, imagePoint, brushSize, tool) > 0) {
      gesture.changed = true;
    }
    gesture.lastImagePoint = imagePoint;
    setDraftRevision((revision) => revision + 1);
  }

  function finishGesture(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = undefined;
    if (gesture.kind === "draw") {
      const draft = draftRef.current;
      draftRef.current = undefined;
      if (commit && gesture.changed && draft) {
        setHistory((current) => commitMaskHistory(current, draft));
      }
      setDraftRevision((revision) => revision + 1);
    }
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (setup.status !== "ready" || !capabilityReady) {
      return;
    }
    event.preventDefault();
    const cursor = eventPoint(event);
    setCursorPoint(cursor);
    setViewport((current) =>
      zoomMaskViewportAt(
        current,
        cursor,
        wheelMaskZoom(current.scale, event.deltaY),
        setup.imageSize,
        viewportSize
      )
    );
  }

  function attemptClose() {
    if (maskCloseDisposition(dirty) === "confirm-discard") {
      setConfirmClose(true);
    } else {
      onClose();
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      const root = confirmClose
        ? dialogRef.current?.querySelector<HTMLElement>(".mask-confirm__panel")
        : dialogRef.current;
      const focusable = root
        ? Array.from(
            root.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
            )
          ).filter((element) => element.getClientRects().length > 0)
        : [];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first && last) {
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    const action = resolveMaskShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      editableTarget: editableKeyboardTarget(event.target)
    });
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action === "close") {
      if (confirmClose) {
        setConfirmClose(false);
      } else {
        attemptClose();
      }
    } else if (action === "brush") {
      setTool("brush");
    } else if (action === "eraser") {
      setTool("eraser");
    } else if (action === "pan") {
      setTool("pan");
    } else if (action === "undo") {
      undo();
    } else if (action === "redo") {
      redo();
    } else if (action === "fit") {
      fitCanvas();
    } else if (action === "toggle-overlay") {
      setOverlayVisible((visible) => !visible);
    } else if (action === "decrease-brush") {
      setBrushSize((size) => clampBrushSize(size - Math.max(1, Math.round(size / 8))));
    } else if (action === "increase-brush") {
      setBrushSize((size) => clampBrushSize(size + Math.max(1, Math.round(size / 8))));
    }
  }

  async function saveMask() {
    if (
      setup.status !== "ready" ||
      !capabilityReady ||
      targetState.status !== "ready" ||
      !targetDecoded
    ) {
      setSaveState("failure");
      return;
    }
    const mask = cloneMaskBitmap(currentMask);
    if (isMaskBitmapEmpty(mask)) {
      setSaveState("empty");
      return;
    }
    try {
      setSaveState("encoding");
      const blob = await encodeMaskPng(mask);
      setSaveState("uploading");
      const resource = await onUploadMask({
        blob,
        purpose: "mask",
        width: setup.imageSize.width,
        height: setup.imageSize.height,
        targetSlot: 0
      });
      const locator = bindFinalizedMaskUpload(resource, setup.imageSize);
      onSave(locator);
      setBaseline(cloneMaskBitmap(mask));
      setSaveState("success");
    } catch {
      setSaveState("failure");
    }
  }

  const transformStyle: CSSProperties = setup.status === "ready"
    ? {
        width: setup.imageSize.width,
        height: setup.imageSize.height,
        transform: `translate3d(${viewport.offsetX}px, ${viewport.offsetY}px, 0) scale(${viewport.scale})`
      }
    : {};
  const cursorStyle: CSSProperties | undefined =
    cursorPoint && setup.status === "ready" && tool !== "pan"
      ? {
          width: brushSize * viewport.scale,
          height: brushSize * viewport.scale,
          transform: `translate3d(${cursorPoint.x}px, ${cursorPoint.y}px, 0) translate(-50%, -50%)`
        }
      : undefined;

  function confirmTargetDecoded(event: SyntheticEvent<HTMLImageElement>) {
    if (
      setup.status !== "ready" ||
      event.currentTarget.naturalWidth !== setup.imageSize.width ||
      event.currentTarget.naturalHeight !== setup.imageSize.height
    ) {
      setTargetDecoded(false);
      setTargetState({ status: "failure" });
      return;
    }
    setTargetDecoded(true);
  }

  let statusMessage: string = dirty ? labels.dirty : labels.clean;
  if (saveState === "encoding") statusMessage = labels.saving;
  if (saveState === "uploading") statusMessage = labels.uploading;
  if (saveState === "success" && !dirty) statusMessage = labels.saved;
  if (saveState === "empty") statusMessage = labels.emptyMask;
  if (saveState === "failure") statusMessage = labels.saveFailure;

  return (
    <div
      ref={dialogRef}
      className="mask-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mask-editor-title"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <header className="mask-editor__header">
        <div>
          <p className="mask-editor__eyebrow">{labels.eyebrow}</p>
          <h1 id="mask-editor-title">{labels.title}</h1>
        </div>
        <div className="mask-editor__header-actions">
          <button className="mask-control" type="button" onClick={attemptClose}>
            {labels.close}
          </button>
          <button
            className="mask-control mask-control--primary"
            type="button"
            disabled={
              !capabilityReady ||
              setup.status !== "ready" ||
              targetState.status !== "ready" ||
              !targetDecoded ||
              saveState === "encoding" ||
              saveState === "uploading" ||
              (saveState === "success" && !dirty)
            }
            onClick={() => void saveMask()}
          >
            {saveState === "encoding"
              ? labels.saving
              : saveState === "uploading"
                ? labels.uploading
                : labels.save}
          </button>
        </div>
      </header>

      {!capabilityReady ? (
        <section className="mask-editor__blocking" role="alert">
          <span className="mask-editor__blocking-code">CAPABILITY / {capability.toUpperCase()}</span>
          <h2>{labels.unavailable}</h2>
          <p>{labels.unavailableDetail}</p>
        </section>
      ) : setup.status !== "ready" ? (
        <section className="mask-editor__blocking" role="alert">
          <span className="mask-editor__blocking-code">TARGET / INVALID</span>
          <h2>{target || targetBlob ? labels.setupFailure : labels.missingTarget}</h2>
        </section>
      ) : (
        <main className="mask-editor__workspace">
          <aside className="mask-editor__tools" aria-label={labels.title}>
            <div className="mask-tool-group" role="group" aria-label={labels.title}>
              <button
                className="mask-tool"
                type="button"
                aria-pressed={tool === "brush"}
                onClick={() => setTool("brush")}
              >
                <span className="mask-tool__key">B</span>
                {labels.brush}
              </button>
              <button
                className="mask-tool"
                type="button"
                aria-pressed={tool === "eraser"}
                onClick={() => setTool("eraser")}
              >
                <span className="mask-tool__key">E</span>
                {labels.eraser}
              </button>
              <button
                className="mask-tool"
                type="button"
                aria-pressed={tool === "pan"}
                onClick={() => setTool("pan")}
              >
                <span className="mask-tool__key">H</span>
                {labels.pan}
              </button>
            </div>
            <div className="mask-tool-group mask-tool-group--compact" role="group">
              <button className="mask-tool" type="button" disabled={!canUndoMask(history)} onClick={undo}>
                {labels.undo}
              </button>
              <button className="mask-tool" type="button" disabled={!canRedoMask(history)} onClick={redo}>
                {labels.redo}
              </button>
              <button className="mask-tool" type="button" disabled={isMaskBitmapEmpty(currentMask)} onClick={clear}>
                {labels.clear}
              </button>
            </div>
          </aside>

          <div
            ref={stageRef}
            role="region"
            className={`mask-editor__stage mask-editor__stage--${tool}`}
            aria-label={labels.canvasLabel}
            onPointerDown={beginGesture}
            onPointerMove={moveGesture}
            onPointerUp={(event) => finishGesture(event, true)}
            onPointerCancel={(event) => finishGesture(event, false)}
            onPointerLeave={() => {
              if (!gestureRef.current) setCursorPoint(undefined);
            }}
            onWheel={handleWheel}
          >
            {targetState.status === "loading" || (targetState.status === "ready" && !targetDecoded) ? (
              <div className="mask-editor__stage-state" role="status">{labels.loading}</div>
            ) : null}
            {targetState.status === "failure" ? (
              <div className="mask-editor__stage-state" role="alert">{labels.resourceFailure}</div>
            ) : null}
            {targetState.status === "ready" ? (
              <div className="mask-editor__plate" style={transformStyle}>
                <img
                  className="mask-editor__target"
                  src={targetState.resource.url}
                  alt={targetAlt}
                  width={setup.imageSize.width}
                  height={setup.imageSize.height}
                  draggable={false}
                  onLoad={confirmTargetDecoded}
                  onError={() => {
                    setTargetDecoded(false);
                    setTargetState({ status: "failure" });
                  }}
                />
                <canvas
                  ref={overlayCanvasRef}
                  className="mask-editor__overlay"
                  role="img"
                  aria-label={labels.canvasLabel}
                  width={setup.imageSize.width}
                  height={setup.imageSize.height}
                  style={{
                    opacity: overlayOpacity,
                    visibility: overlayVisible ? "visible" : "hidden"
                  }}
                />
              </div>
            ) : null}
            {cursorStyle ? <span className="mask-editor__cursor" aria-hidden="true" style={cursorStyle} /> : null}
            <output className="mask-editor__zoom" aria-label={labels.zoom}>
              {Math.round(viewport.scale * 100)}%
            </output>
          </div>

          <aside className="mask-editor__inspector">
            <section className="mask-inspector-section">
              <div className="mask-inspector-section__heading">
                <h2>{labels.brushSize}</h2>
                <output>{brushSize}px</output>
              </div>
              <input
                aria-label={labels.brushSize}
                type="range"
                min="1"
                max="512"
                value={brushSize}
                onChange={(event) => setBrushSize(clampBrushSize(Number(event.currentTarget.value)))}
              />
            </section>
            <section className="mask-inspector-section">
              <div className="mask-inspector-section__heading">
                <h2>{labels.overlay}</h2>
                <output>{Math.round(overlayOpacity * 100)}%</output>
              </div>
              <label className="mask-toggle">
                <input
                  type="checkbox"
                  checked={overlayVisible}
                  onChange={(event) => setOverlayVisible(event.currentTarget.checked)}
                />
                {labels.overlayVisible}
              </label>
              <input
                aria-label={labels.overlayOpacity}
                type="range"
                min="0.1"
                max="1"
                step="0.05"
                value={overlayOpacity}
                onChange={(event) => setOverlayOpacity(Number(event.currentTarget.value))}
              />
            </section>
            <section className="mask-inspector-section">
              <div className="mask-zoom-controls" role="group" aria-label={labels.zoom}>
                <button type="button" onClick={() => changeZoom(1 / 1.25)} aria-label={labels.zoomOut}>−</button>
                <button type="button" onClick={fitCanvas}>{labels.fit}</button>
                <button type="button" onClick={() => changeZoom(1.25)} aria-label={labels.zoomIn}>+</button>
              </div>
            </section>
            {capability === "degraded" ? (
              <p className="mask-editor__degraded" role="status">{labels.degraded}</p>
            ) : null}
            <p className="mask-editor__shortcuts">{labels.shortcuts}</p>
          </aside>
        </main>
      )}

      <footer className="mask-editor__footer">
        <span className={dirty ? "mask-editor__dirty-light is-active" : "mask-editor__dirty-light"} aria-hidden="true" />
        <span role={saveState === "failure" || saveState === "empty" ? "alert" : "status"}>{statusMessage}</span>
        <span className="mask-editor__slot">MASK → TARGET[0]</span>
      </footer>

      {confirmClose ? (
        <div className="mask-confirm" role="alertdialog" aria-modal="true" aria-labelledby="mask-confirm-title">
          <div className="mask-confirm__panel">
            <p className="mask-editor__eyebrow">UNSAVED / LOCAL ONLY</p>
            <h2 id="mask-confirm-title">{labels.discardTitle}</h2>
            <p>{labels.discardBody}</p>
            <div className="mask-confirm__actions">
              <button className="mask-control" type="button" autoFocus onClick={() => setConfirmClose(false)}>
                {labels.keepEditing}
              </button>
              <button className="mask-control mask-control--danger" type="button" onClick={onClose}>
                {labels.discard}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
