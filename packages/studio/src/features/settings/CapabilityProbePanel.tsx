import { useMemo, useState } from "react";

import type {
  CapabilityProbeResult,
  ProviderCapability,
  ReadSettingsResult
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { useI18n } from "../../i18n";

type DefaultCapability =
  | "custom-size"
  | "quality-control"
  | "native-variants"
  | "output-format"
  | "native-transparency";

type ProbeState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "complete"; readonly results: readonly CapabilityProbeResult[] }
  | { readonly status: "failure"; readonly message: string };

const probeDetails: Record<DefaultCapability, { readonly zh: string; readonly en: string }> = {
  "custom-size": {
    zh: "自定义尺寸与比例",
    en: "Custom size and aspect ratio"
  },
  "quality-control": {
    zh: "指定图片质量",
    en: "Requested image quality"
  },
  "native-variants": {
    zh: "一次返回多张图片",
    en: "Multiple outputs in one request"
  },
  "output-format": {
    zh: "指定输出文件格式",
    en: "Requested output file format"
  },
  "native-transparency": {
    zh: "原生透明背景",
    en: "Native transparent background"
  }
};

function requiredCapabilities(defaults: ReadSettingsResult["defaults"]): readonly DefaultCapability[] {
  return [
    ...(defaults.size !== "auto" || defaults.aspectRatio !== "auto" ? ["custom-size" as const] : []),
    ...(defaults.quality !== "auto" ? ["quality-control" as const] : []),
    ...(defaults.count > 1 ? ["native-variants" as const] : []),
    ...(defaults.format !== "png" ? ["output-format" as const] : []),
    ...(defaults.transparentMode === "native" ? ["native-transparency" as const] : [])
  ];
}

function capabilityDetail(capability: ProviderCapability, language: "zh" | "en"): string {
  return capability in probeDetails
    ? probeDetails[capability as DefaultCapability][language]
    : capability;
}

function capabilityStateLabel(state: CapabilityProbeResult["record"]["state"], language: "zh" | "en"): string {
  const labels = language === "zh"
    ? { supported: "已验证支持", unsupported: "已验证不支持", degraded: "仅降级支持", unknown: "未能确定" }
    : { supported: "Supported", unsupported: "Unsupported", degraded: "Degraded", unknown: "Inconclusive" };
  return labels[state];
}

function probeErrorMessage(result: CapabilityProbeResult, language: "zh" | "en"): string | undefined {
  if (result.record.capability === "custom-size" && result.record.state === "degraded") {
    return language === "zh"
      ? "上游已接受本次尺寸参数，但测试图链接无法读取，尚未核对实际像素。工作台仅会放行本次尺寸，成图仍会严格核验。"
      : "The provider accepted this size, but its test-image URL could not be read for pixel verification. Only this size is allowed; completed images are still checked strictly.";
  }
  if (result.error === undefined) return undefined;
  if (language === "zh" && result.error.code === "invalid_response") {
    const reason = result.error.details?.["reason"];
    if (reason === "returned-image-url-could-not-be-verified" || reason === "returned-image-url-inspection-failed") {
      return "上游已返回测试图链接，但该链接无法被安全读取，无法核对实际像素尺寸。";
    }
    if (reason === "capability-specific-proof-missing") {
      return "上游接受了请求，但没有按可识别的图片格式返回测试图，无法核对实际像素尺寸。";
    }
    return "本次响应没有提供可用于核对实际像素尺寸的证据。";
  }
  return result.error.safeMessage;
}

export function CapabilityProbePanel({
  gateway,
  settings,
  compact = false
}: {
  readonly gateway: StudioGateway;
  readonly settings: ReadSettingsResult;
  readonly compact?: boolean;
}) {
  const { language } = useI18n();
  const active = settings.profiles.find((profile) => profile.id === settings.activeProviderId && profile.isActive);
  const model = settings.defaults.model ?? active?.defaultModel;
  const requirements = useMemo(() => requiredCapabilities(settings.defaults), [settings.defaults]);
  const [state, setState] = useState<ProbeState>({ status: "idle" });
  const isChinese = language === "zh";

  const runProbe = async () => {
    if (active === undefined || model === undefined || requirements.length === 0) return;
    setState({ status: "running" });
    const results: CapabilityProbeResult[] = [];
    try {
      for (const capability of requirements) {
        const result = await gateway.invoke("probeCapabilities", {
          schemaVersion: 1,
          providerId: active.id,
          model,
          capability,
          transport: capability === "quality-control" && active.endpoints.generation.mode === "legacy-api-base"
            ? "openai-images"
            : "single-endpoint-json",
          requestShape: capability === "quality-control" && active.endpoints.generation.mode === "legacy-api-base"
            ? "openai-images:generations-json"
            : "single-endpoint-json:text",
          ...(capability === "custom-size" && settings.defaults.size !== "auto"
            ? { requestedSize: settings.defaults.size }
            : {}),
          ...(capability === "quality-control" && settings.defaults.quality !== "auto"
            ? { requestedQuality: settings.defaults.quality }
            : {}),
          confirmBillableProbe: true
        });
        results.push(result);
      }
      setState({ status: "complete", results });
    } catch {
      setState({
        status: "failure",
        message: isChinese
          ? "探测未能完成。服务商可能已收到请求；请在账单中按实际情况确认。"
          : "The probe did not complete. The provider may have received the request; check billing as appropriate."
      });
    }
  };

  const allVerified = state.status === "complete" && state.results.every(
    (result) => result.status === "completed" && result.record.state === "supported"
  );

  const explanation = <>
      <div className="settings-section-heading">
        <p>VERIFY / OPTIONAL CONTROLS</p>
        <h2 id="capability-probe-title">{isChinese ? "验证当前默认参数" : "Verify current defaults"}</h2>
      </div>
      <p>
        {isChinese
          ? "探测会按已保存的当前服务商、模型和默认参数发出小型验证请求。它不会把测试图存入图库，但每一项都可能产生服务商费用。"
          : "The probe sends small verification requests for the saved provider, model, and defaults. Test images are not saved to Library, but each request may be billable by the provider."}
      </p>
      {requirements.length > 0 ? (
        <>
          <ul className="capability-probe__requirements">
            {requirements.map((capability) => <li key={capability}>
              {capabilityDetail(capability, language)}
              {capability === "custom-size" && settings.defaults.size !== "auto"
                ? (isChinese
                  ? `：将生成并核对实际 ${settings.defaults.size} 像素尺寸`
                  : `: generates and checks the actual ${settings.defaults.size} pixel dimensions`)
                : ""}
              {capability === "quality-control" && settings.defaults.quality !== "auto"
                ? (isChinese
                  ? `：将发送并确认 ${settings.defaults.quality} 质量参数`
                  : `: sends and confirms the ${settings.defaults.quality} quality parameter`)
                : ""}
            </li>)}
          </ul>
          <p className="capability-probe__scope">
            {isChinese
              ? `本次将顺序执行 ${requirements.length} 次探测；结果只适用于当前服务商、模型和调用端点。`
              : `${requirements.length} probe request(s) run sequentially. Results apply only to this provider, model, and endpoint.`}
          </p>
        </>
      ) : (
        <p className="capability-probe__scope">
          {isChinese
            ? "当前默认值没有启用需要额外验证的参数。保存自定义尺寸、指定质量、多张输出、JPEG/WebP 或原生透明后，可在这里验证。"
          : "The current defaults do not use an optional control that needs verification. Save a custom size, requested quality, multiple outputs, JPEG/WebP, or native transparency to verify it here."}
        </p>
      )}
    </>;

  const feedback = <>
      {active === undefined || model === undefined ? (
        <p className="capability-probe__message is-failure" role="alert">
          {isChinese ? "请先保存并启用含模型的服务商资料。" : "Save and activate a provider profile with a model first."}
        </p>
      ) : null}
      {state.status === "failure" ? <p className="capability-probe__message is-failure" role="alert">{state.message}</p> : null}
      {state.status === "complete" ? (
        <div className={`capability-probe__result ${allVerified ? "is-success" : "is-warning"}`} role="status">
          <strong>{allVerified
            ? (isChinese ? "验证完成：当前默认参数的可选控制已获服务商确认。" : "Verification complete: the provider confirmed the optional controls in these defaults.")
            : (isChinese ? "验证未获得完整确认：请查看每项可执行结论。" : "Verification did not obtain full confirmation: review each actionable result.")}
          </strong>
          <ul>
            {state.results.map((result) => (
              <li key={result.record.capability}>
                {capabilityDetail(result.record.capability, language)}：{capabilityStateLabel(result.record.state, language)}
                {probeErrorMessage(result, language) === undefined ? "" : `（${probeErrorMessage(result, language)}）`}
              </li>
            ))}
          </ul>
          <p>
            {isChinese
              ? "尺寸验证“支持”表示服务商返回的测试图已实际匹配当前设置的像素尺寸。每次正式生成后，Routego 仍会核对图片的比例、分辨率、格式和数量；不一致会明确失败且不会存入图库。"
              : "Supported means the provider accepted that parameter channel. Routego still checks each completed generation for the requested ratio, resolution, format, and count; a mismatch fails clearly and is not saved to Library."}
          </p>
        </div>
      ) : null}
    </>;

  const probeButton = requirements.length > 0 ? (
    <button type="button" onClick={() => void runProbe()} disabled={state.status === "running" || active === undefined || model === undefined}>
      {state.status === "running"
        ? (isChinese ? "正在验证…" : "Verifying…")
        : (isChinese ? "开始验证（可能计费）" : "Start verification (may be billable)")}
    </button>
  ) : null;

  return (
    <section className={`capability-probe${compact ? " capability-probe--compact" : ""}`} aria-labelledby="capability-probe-title">
      {compact ? (
        <details className="capability-probe__disclosure">
          <summary>{isChinese ? "验证说明" : "Verification details"}</summary>
          <div className="capability-probe__disclosure-body">{explanation}</div>
        </details>
      ) : explanation}
      {probeButton}
      {feedback}
    </section>
  );
}
