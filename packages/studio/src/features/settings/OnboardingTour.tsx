import { useEffect, useState, type CSSProperties } from "react";

import { useI18n } from "../../i18n";

export type OnboardingStep = "provider" | "defaults" | "finish";

interface OnboardingTourProps {
  readonly step: OnboardingStep;
  readonly preview: boolean;
  readonly onAdvance: () => void;
  readonly onBack: (() => void) | undefined;
  readonly onDismiss: () => void;
}

interface TourPosition {
  readonly target: CSSProperties;
  readonly bubble: CSSProperties;
  readonly placement: "top" | "right" | "bottom" | "left" | "center";
}

const copy = {
  zh: {
    provider: {
      title: "连接服务商",
      body: "在高亮区域填写名称、调用地址、API Key 和默认模型。保存成功后会自动进入下一步。"
    },
    providerPreview: {
      title: "查看服务商",
      body: "这是当前已保存的服务商配置。API Key 始终隐藏，查看引导不会修改任何设置。"
    },
    defaults: {
      title: "保存默认参数",
      body: "按需要调整图片比例、清晰度和输出选项，然后使用高亮的保存按钮确认。"
    },
    defaultsPreview: {
      title: "查看默认参数",
      body: "这里显示 Codex 会默认使用的出图参数。预览引导不会写入任何改动。"
    },
    finish: {
      title: "可以开始创作了",
      body: "回到 Codex 对话，直接描述你想生成的图片即可。之后随时可在供应商管理中重新查看此引导。"
    },
    step: "引导 {current} / 3",
    close: "关闭新手引导",
    back: "上一步",
    next: "继续",
    done: "完成",
    waiting: "完成高亮区域中的操作后，引导会自动继续。"
  },
  en: {
    provider: {
      title: "Connect a provider",
      body: "Enter a name, API endpoint, API key, and default model in the highlighted form. The guide continues after a successful save."
    },
    providerPreview: {
      title: "Review the provider",
      body: "This is the saved provider configuration. API keys remain hidden, and reviewing the guide does not change settings."
    },
    defaults: {
      title: "Save image defaults",
      body: "Adjust image ratio, quality, and output options as needed, then use the highlighted save button to confirm them."
    },
    defaultsPreview: {
      title: "Review image defaults",
      body: "These are the defaults Codex uses for image requests. Reviewing the guide never saves changes."
    },
    finish: {
      title: "Ready to create",
      body: "Return to a Codex conversation and describe the image you want to create. You can reopen this guide from Provider management at any time."
    },
    step: "GUIDE {current} / 3",
    close: "Close onboarding",
    back: "Back",
    next: "Continue",
    done: "Done",
    waiting: "The guide continues after you complete the highlighted action."
  }
} as const;

function targetSelector(step: OnboardingStep, preview: boolean): string | undefined {
  if (step === "provider") return preview ? '[data-onboarding-target="provider-summary"]' : '[data-onboarding-target="provider-form"]';
  if (step === "defaults") return '[data-onboarding-target="defaults-save"]';
  return undefined;
}

function stepIndex(step: OnboardingStep): number {
  if (step === "provider") return 1;
  if (step === "defaults") return 2;
  return 3;
}

function positionFor(target: HTMLElement | null): TourPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const bubbleWidth = Math.min(352, viewportWidth - 32);
  const bubbleHeight = 212;

  if (target === null) {
    return {
      target: { display: "none" },
      bubble: {
        left: Math.max(16, Math.round((viewportWidth - bubbleWidth) / 2)),
        top: Math.max(16, Math.round((viewportHeight - bubbleHeight) / 2)),
        width: bubbleWidth
      },
      placement: "center"
    };
  }

  const rect = target.getBoundingClientRect();
  const gutter = 12;
  const x = Math.max(8, rect.left - gutter);
  const y = Math.max(8, rect.top - gutter);
  const width = Math.min(viewportWidth - x - 8, rect.width + gutter * 2);
  const height = Math.min(viewportHeight - y - 8, rect.height + gutter * 2);
  const canUseSidePlacement = viewportWidth > 720;
  const clampX = (value: number) => Math.max(16, Math.min(value, viewportWidth - bubbleWidth - 16));
  const clampY = (value: number) => Math.max(16, Math.min(value, viewportHeight - bubbleHeight - 16));

  let placement: TourPosition["placement"] = "bottom";
  let bubbleLeft = clampX(rect.left + (rect.width - bubbleWidth) / 2);
  let bubbleTop = rect.bottom + gutter + 16;
  if (canUseSidePlacement && rect.right + gutter + 16 + bubbleWidth <= viewportWidth - 16) {
    placement = "right";
    bubbleLeft = rect.right + gutter + 16;
    bubbleTop = clampY(rect.top + rect.height / 2 - bubbleHeight / 2);
  } else if (canUseSidePlacement && rect.left - gutter - 16 - bubbleWidth >= 16) {
    placement = "left";
    bubbleLeft = rect.left - gutter - 16 - bubbleWidth;
    bubbleTop = clampY(rect.top + rect.height / 2 - bubbleHeight / 2);
  } else if (bubbleTop + bubbleHeight > viewportHeight - 16) {
    placement = "top";
    bubbleTop = rect.top - gutter - 16 - bubbleHeight;
  }

  return {
    target: { left: Math.round(x), top: Math.round(y), width: Math.round(width), height: Math.round(height) },
    bubble: { left: Math.round(clampX(bubbleLeft)), top: Math.round(clampY(bubbleTop)), width: bubbleWidth },
    placement
  };
}

export function OnboardingTour({ step, preview, onAdvance, onBack, onDismiss }: OnboardingTourProps) {
  const { language } = useI18n();
  const labels = copy[language];
  const selector = targetSelector(step, preview);
  const [position, setPosition] = useState<TourPosition | undefined>(undefined);
  const details = step === "provider"
    ? preview ? labels.providerPreview : labels.provider
    : step === "defaults"
      ? preview ? labels.defaultsPreview : labels.defaults
      : labels.finish;
  const canAdvance = preview || step === "finish";

  useEffect(() => {
    const target = selector === undefined ? null : document.querySelector<HTMLElement>(selector);
    target?.scrollIntoView({ block: window.innerWidth < 720 ? "start" : "center", behavior: "smooth" });

    let frame = 0;
    const updatePosition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setPosition(positionFor(target)));
    };
    const resizeObserver = target === null ? undefined : new ResizeObserver(updatePosition);
    if (target !== null) resizeObserver?.observe(target);
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [selector, step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const style = position?.bubble;
  const spotlightStyle = position?.target;
  const placement = position?.placement ?? "center";
  return (
    <aside className="onboarding-tour" data-ready={position === undefined ? "false" : "true"} data-onboarding-step={step} aria-label={labels.step.replace("{current}", String(stepIndex(step)))}>
      <div className="onboarding-tour__spotlight" aria-hidden="true" style={spotlightStyle} />
      <section className="onboarding-tour__bubble" data-placement={placement} role="dialog" aria-live="polite" style={style}>
        <div className="onboarding-tour__bar">
          <span>{labels.step.replace("{current}", String(stepIndex(step)))}</span>
          <button className="onboarding-tour__close" type="button" aria-label={labels.close} onClick={onDismiss}>x</button>
        </div>
        <h2>{details.title}</h2>
        <p>{details.body}</p>
        <footer>
          {onBack === undefined ? <span>{canAdvance ? null : labels.waiting}</span> : <button className="onboarding-tour__secondary" type="button" onClick={onBack}>{labels.back}</button>}
          {canAdvance ? <button className="onboarding-tour__primary" type="button" onClick={onAdvance}>{step === "finish" ? labels.done : labels.next}</button> : null}
        </footer>
      </section>
    </aside>
  );
}
