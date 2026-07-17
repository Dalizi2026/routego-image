import type { LibraryAssetDetail, LibraryOperationParameters } from "@routego-image/contracts";

import type { CreationDraft, DraftImageInput } from "../creation";
import type { LibraryCreationHandoff } from "./types";

function controls(parameters: LibraryOperationParameters): CreationDraft["controls"] {
  return {
    size: parameters.size,
    aspectRatio: parameters.aspectRatio,
    quality: parameters.quality,
    format: parameters.format,
    ...(parameters.compression === undefined ? {} : { compression: parameters.compression }),
    count: parameters.count,
    partialImages: parameters.partialImages,
    transparentMode: parameters.transparentMode,
    moderation: parameters.moderation,
    action: parameters.action,
    ...(parameters.previousResponseId === undefined
      ? {}
      : { previousResponseId: parameters.previousResponseId }),
    saveToLibrary: parameters.saveToLibrary
  };
}

function parameterImage(
  assetId: string,
  role: DraftImageInput["role"],
  label: string | undefined,
  id: string
): DraftImageInput {
  return {
    id,
    role,
    ...(label === undefined ? {} : { label }),
    locator: { source: "asset", assetId }
  };
}

export function createLibraryRetryHandoff(asset: LibraryAssetDetail): LibraryCreationHandoff {
  const parameters = asset.effectiveParams;
  const draft: CreationDraft = {
    mode: parameters.kind,
    prompt: parameters.prompt,
    references: parameters.references.map((reference, index) =>
      parameterImage(
        reference.assetId,
        reference.role,
        reference.label,
        `library-retry-reference-${index}-${reference.assetId}`
      )
    ),
    ...(parameters.target === undefined
      ? {}
      : {
          target: parameterImage(
            parameters.target.assetId,
            "previous-output",
            parameters.target.label,
            `library-retry-target-${parameters.target.assetId}`
          )
        }),
    supportingImages: parameters.supportingImages.map((supporting, index) =>
      parameterImage(
        supporting.assetId,
        supporting.role,
        supporting.label,
        `library-retry-supporting-${index}-${supporting.assetId}`
      )
    ),
    ...(parameters.maskAssetId === undefined
      ? {}
      : {
          mask: {
            image: { source: "asset", assetId: parameters.maskAssetId },
            targetSlot: 0 as const
          }
        }),
    invariants: parameters.invariants ?? {
      allowedChanges: [],
      preserve: [],
      forbiddenChanges: []
    },
    controls: controls(parameters)
  };
  return { action: "retry", assetId: asset.id, draft };
}

export function createLibraryEditHandoff(asset: LibraryAssetDetail): LibraryCreationHandoff {
  const parameters = asset.effectiveParams;
  return {
    action: "edit",
    assetId: asset.id,
    draft: {
      mode: "edit",
      prompt: parameters.prompt,
      references: parameters.references.map((reference, index) =>
        parameterImage(
          reference.assetId,
          reference.role,
          reference.label,
          `library-edit-reference-${index}-${reference.assetId}`
        )
      ),
      target: parameterImage(
        asset.id,
        "previous-output",
        asset.prompt,
        `library-edit-target-${asset.id}`
      ),
      supportingImages: [],
      invariants: parameters.invariants ?? {
        allowedChanges: [],
        preserve: [],
        forbiddenChanges: []
      },
      controls: {
        ...controls(parameters),
        action: parameters.action === "generate" ? "auto" : parameters.action
      }
    }
  };
}

export function isIdentifierOnlyLibraryHandoff(handoff: LibraryCreationHandoff): boolean {
  const images = [
    ...handoff.draft.references,
    ...(handoff.draft.target === undefined ? [] : [handoff.draft.target]),
    ...handoff.draft.supportingImages
  ];
  return (
    images.every(
      (image) => image.locator !== undefined && image.upload === undefined && image.resource === undefined
    ) &&
    handoff.draft.maskUpload === undefined &&
    (handoff.draft.mask === undefined || handoff.draft.mask.targetSlot === 0)
  );
}
