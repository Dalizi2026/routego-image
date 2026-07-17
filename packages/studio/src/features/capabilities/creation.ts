import type { ProviderCapability } from "@routego-image/contracts";

import type { CreationDraft } from "../creation/types";
import {
  combineCapabilityDecisions,
  UNCONFIRMED_CAPABILITY_MESSAGE,
  type CapabilityDecision
} from "./state";

export type CapabilityResolver = (capability: ProviderCapability) => CapabilityDecision;

export class CreationCapabilityError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(fields: Readonly<Record<string, string>>) {
    super(UNCONFIRMED_CAPABILITY_MESSAGE);
    this.name = "CreationCapabilityError";
    this.fields = fields;
  }
}

function requireDecision(
  resolve: CapabilityResolver,
  capability: ProviderCapability,
  field: string,
  fields: Record<string, string>,
  options: { readonly supportedOnly?: boolean } = {}
): CapabilityDecision {
  const decision = resolve(capability);
  const allowed = options.supportedOnly ? decision.state === "supported" : decision.enabled;
  if (!allowed) {
    fields[field] = UNCONFIRMED_CAPABILITY_MESSAGE;
  }
  return decision;
}

export function normalizeCreationDraftForCapabilities(
  draft: CreationDraft,
  resolve: CapabilityResolver
): CreationDraft {
  const customSize = resolve("custom-size");
  const quality = resolve("quality-control");
  const outputFormat = resolve("output-format");
  const compression = resolve("compression");
  const variants = resolve("native-variants");
  const partial = combineCapabilityDecisions("partial-images", [
    resolve("streaming"),
    resolve("partial-images")
  ]);
  const transparency = resolve("native-transparency");
  const moderation = resolve("moderation");
  const responses = resolve("responses-state");
  const size =
    customSize.enabled &&
    (draft.controls.size === "auto" ||
      customSize.record?.limits?.supportedSizes === undefined ||
      customSize.record.limits.supportedSizes.includes(draft.controls.size))
      ? draft.controls.size
      : "auto";
  const qualityValue =
    quality.enabled &&
    (draft.controls.quality === "auto" ||
      quality.record?.limits?.supportedQualities === undefined ||
      quality.record.limits.supportedQualities.includes(draft.controls.quality))
      ? draft.controls.quality
      : "auto";
  const format =
    outputFormat.enabled &&
    (outputFormat.record?.limits?.supportedFormats === undefined ||
      outputFormat.record.limits.supportedFormats.includes(draft.controls.format))
      ? draft.controls.format
      : outputFormat.enabled
        ? outputFormat.record?.limits?.supportedFormats?.[0] ?? "png"
        : "png";
  return {
    ...draft,
    controls: {
      ...draft.controls,
      size,
      aspectRatio: customSize.enabled ? draft.controls.aspectRatio : "auto",
      quality: qualityValue,
      format,
      compression:
        compression.enabled && format !== "png" ? draft.controls.compression : undefined,
      count: variants.enabled
        ? Math.min(draft.controls.count, variants.record?.limits?.maxVariants ?? 4)
        : 1,
      partialImages: partial.enabled
        ? Math.min(draft.controls.partialImages, partial.record?.limits?.maxPartialImages ?? 3)
        : 0,
      transparentMode:
        transparency.state === "supported"
          ? draft.controls.transparentMode
          : transparency.state === "degraded" && draft.controls.transparentMode !== "native"
            ? draft.controls.transparentMode
            : "off",
      moderation: moderation.enabled ? draft.controls.moderation : "auto",
      action: responses.enabled ? draft.controls.action : "auto",
      previousResponseId: responses.enabled ? draft.controls.previousResponseId : undefined
    }
  };
}

export function validateCreationCapabilities(
  draft: CreationDraft,
  resolve: CapabilityResolver
): readonly string[] {
  const fields: Record<string, string> = {};
  const degraded: string[] = [];
  const physicalInputs =
    draft.references.length + draft.supportingImages.length + (draft.target === undefined ? 0 : 1);
  if (physicalInputs > 0) {
    const single = requireDecision(resolve, "single-image-input", "images", fields);
    if (single.state === "degraded" && single.detail) degraded.push(single.detail);
  }
  if (physicalInputs > 1) {
    const multi = requireDecision(resolve, "multi-image-input", "images", fields);
    if (multi.state === "degraded" && multi.detail) degraded.push(multi.detail);
    if (
      multi.record?.limits?.maxImages !== undefined &&
      physicalInputs > multi.record.limits.maxImages
    ) {
      fields["images"] = `当前能力证据最多允许 ${multi.record.limits.maxImages} 张输入图。`;
    }
  }
  if (draft.mode === "edit") {
    const edit = requireDecision(resolve, "target-edit", "mode", fields);
    if (edit.state === "degraded" && edit.detail) degraded.push(edit.detail);
  }
  if (draft.controls.size !== "auto" || draft.controls.aspectRatio !== "auto") {
    const size = requireDecision(resolve, "custom-size", "size", fields);
    if (
      draft.controls.size !== "auto" &&
      size.record?.limits?.supportedSizes !== undefined &&
      !size.record.limits.supportedSizes.includes(draft.controls.size)
    ) {
      fields["size"] = "当前能力证据不包含这个尺寸。";
    }
  }
  if (draft.controls.quality !== "auto") {
    const quality = requireDecision(resolve, "quality-control", "quality", fields);
    if (
      quality.record?.limits?.supportedQualities !== undefined &&
      !quality.record.limits.supportedQualities.includes(draft.controls.quality)
    ) {
      fields["quality"] = "当前能力证据不包含这个质量档位。";
    }
  }
  if (draft.controls.format !== "png") {
    const format = requireDecision(resolve, "output-format", "format", fields);
    if (
      format.record?.limits?.supportedFormats !== undefined &&
      !format.record.limits.supportedFormats.includes(draft.controls.format)
    ) {
      fields["format"] = "当前能力证据不包含这个输出格式。";
    }
  }
  if (draft.controls.compression !== undefined) {
    requireDecision(resolve, "compression", "compression", fields);
  }
  if (draft.controls.count > 1) {
    const variants = requireDecision(resolve, "native-variants", "count", fields);
    if (
      variants.record?.limits?.maxVariants !== undefined &&
      draft.controls.count > variants.record.limits.maxVariants
    ) {
      fields["count"] = `当前能力证据最多允许 ${variants.record.limits.maxVariants} 个变体。`;
    }
  }
  if (draft.controls.partialImages > 0) {
    const partial = combineCapabilityDecisions("partial-images", [
      resolve("streaming"),
      resolve("partial-images")
    ]);
    if (!partial.enabled) fields["partialImages"] = UNCONFIRMED_CAPABILITY_MESSAGE;
    if (
      partial.record?.limits?.maxPartialImages !== undefined &&
      draft.controls.partialImages > partial.record.limits.maxPartialImages
    ) {
      fields["partialImages"] = `当前能力证据最多允许 ${partial.record.limits.maxPartialImages} 张部分图像。`;
    }
    if (partial.state === "degraded" && partial.detail) degraded.push(partial.detail);
  }
  if (draft.controls.transparentMode !== "off") {
    const transparency = requireDecision(
      resolve,
      "native-transparency",
      "transparentMode",
      fields,
      { supportedOnly: draft.controls.transparentMode === "native" }
    );
    if (transparency.state === "degraded" && transparency.detail) {
      degraded.push(transparency.detail);
    }
  }
  if (draft.controls.moderation === "low") {
    requireDecision(resolve, "moderation", "moderation", fields);
  }
  if (draft.controls.action !== "auto" || draft.controls.previousResponseId !== undefined) {
    const responses = requireDecision(resolve, "responses-state", "continuation", fields);
    if (responses.state === "degraded" && responses.detail) degraded.push(responses.detail);
  }
  if (Object.keys(fields).length > 0) {
    throw new CreationCapabilityError(fields);
  }
  return [...new Set(degraded)];
}
