import {
  studioImageInputRefSchema,
  type LibraryAssetDetail,
  type LibraryOperationParameters
} from "@routego-image/contracts";

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

type LibraryRelationship = LibraryAssetDetail["relationships"][number];
type PhysicalRelationshipRole = "target" | "reference" | "supporting" | "mask";

function handoffFailure(message: string): never {
  throw new Error(`Library handoff unavailable: ${message}`);
}

function parameterAssetImage(
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

function relationshipImage(
  relationship: LibraryRelationship,
  role: DraftImageInput["role"],
  index: number
): DraftImageInput {
  if (relationship.artifactId === undefined) {
    handoffFailure(`the ${relationship.role} relationship has no artifact identifier`);
  }
  return {
    id: `library-retry-${relationship.role}-${index}-${relationship.id}`,
    role,
    ...(relationship.label === undefined ? {} : { label: relationship.label }),
    locator: { source: "artifact", artifactId: relationship.artifactId }
  };
}

function orderedRelationships(
  asset: LibraryAssetDetail,
  role: PhysicalRelationshipRole
): readonly LibraryRelationship[] {
  const relationships = asset.relationships.filter((relationship) => relationship.role === role);
  const relationshipIds = new Set<string>();
  const artifactIds = new Set<string>();
  const orders = new Set<number>();
  const localRenditions = new Map(asset.renditions.map((rendition) => [rendition.artifactId, rendition]));

  for (const relationship of relationships) {
    if (relationshipIds.has(relationship.id)) {
      handoffFailure(`the ${role} relationships are duplicated`);
    }
    relationshipIds.add(relationship.id);
    if (relationship.artifactId === undefined) {
      handoffFailure(`the ${role} relationship has no artifact identifier`);
    }
    if (artifactIds.has(relationship.artifactId)) {
      handoffFailure(`the ${role} relationships reuse an artifact identifier`);
    }
    artifactIds.add(relationship.artifactId);
    if (orders.has(relationship.order)) {
      handoffFailure(`the ${role} relationship order is ambiguous`);
    }
    orders.add(relationship.order);

    const localRendition = localRenditions.get(relationship.artifactId);
    if (relationship.relatedAssetId === asset.id) {
      if (localRendition === undefined || localRendition.phase !== "source") {
        handoffFailure(`the ${role} relationship does not own a source rendition on this asset`);
      }
    } else if (localRendition !== undefined) {
      handoffFailure(`the ${role} relationship assigns a local artifact to another asset`);
    }
  }

  return [...relationships].sort((left, right) => left.order - right.order);
}

function assertExpectedAsset(
  relationship: LibraryRelationship,
  expected: { readonly assetId: string; readonly label?: string | undefined },
  role: PhysicalRelationshipRole,
  index: number
): void {
  if (relationship.relatedAssetId !== expected.assetId) {
    handoffFailure(`the ${role} relationship at index ${index} has inconsistent asset ownership`);
  }
  if (relationship.label !== expected.label) {
    handoffFailure(`the ${role} relationship at index ${index} has inconsistent labeling`);
  }
}

function assertUniquePhysicalRelationships(
  relationships: readonly LibraryRelationship[]
): void {
  const relationshipIds = relationships.map((relationship) => relationship.id);
  const artifactIds = relationships.map((relationship) => relationship.artifactId!);
  const orders = relationships.map((relationship) => relationship.order);
  if (new Set(relationshipIds).size !== relationshipIds.length) {
    handoffFailure("physical input relationship identifiers are duplicated");
  }
  if (new Set(artifactIds).size !== artifactIds.length) {
    handoffFailure("physical input artifact identifiers are duplicated");
  }
  if (new Set(orders).size !== orders.length) {
    handoffFailure("physical input relationship order is ambiguous");
  }
}

function retryInputs(asset: LibraryAssetDetail): {
  readonly references: readonly DraftImageInput[];
  readonly target?: DraftImageInput;
  readonly supportingImages: readonly DraftImageInput[];
  readonly mask?: CreationDraft["mask"];
} {
  const parameters = asset.effectiveParams;

  const references = orderedRelationships(asset, "reference");
  if (references.length !== parameters.references.length) {
    handoffFailure("the reference relationship graph does not match the saved parameters");
  }
  references.forEach((relationship, index) => {
    assertExpectedAsset(relationship, parameters.references[index]!, "reference", index);
  });

  const supportingImages = orderedRelationships(asset, "supporting");
  if (supportingImages.length !== parameters.supportingImages.length) {
    handoffFailure("the supporting-image relationship graph does not match the saved parameters");
  }
  supportingImages.forEach((relationship, index) => {
    assertExpectedAsset(relationship, parameters.supportingImages[index]!, "supporting", index);
  });

  const targetRelationships = orderedRelationships(asset, "target");
  const targetRequired = asset.kind === "edit" || parameters.target !== undefined;
  if (targetRequired && targetRelationships.length !== 1) {
    handoffFailure("an edit retry requires exactly one target relationship");
  }
  if (!targetRequired && targetRelationships.length > 0) {
    handoffFailure("a generate retry cannot contain an unrequested target relationship");
  }
  if (parameters.target !== undefined && targetRelationships[0] !== undefined) {
    assertExpectedAsset(targetRelationships[0], parameters.target, "target", 0);
  }

  const maskRelationships = orderedRelationships(asset, "mask");
  if (parameters.maskAssetId !== undefined && maskRelationships.length !== 1) {
    handoffFailure("the saved mask is missing or ambiguous");
  }
  if (parameters.maskAssetId === undefined && maskRelationships.length > 0) {
    handoffFailure("an unrequested mask relationship cannot be reconstructed safely");
  }
  if (parameters.maskAssetId !== undefined && maskRelationships[0] !== undefined) {
    assertExpectedAsset(
      maskRelationships[0],
      { assetId: parameters.maskAssetId, label: maskRelationships[0].label },
      "mask",
      0
    );
  }

  assertUniquePhysicalRelationships([
    ...targetRelationships,
    ...references,
    ...supportingImages,
    ...maskRelationships
  ]);

  return {
    references: references.map((relationship, index) =>
      relationshipImage(relationship, parameters.references[index]!.role, index)
    ),
    ...(targetRelationships[0] === undefined
      ? {}
      : { target: relationshipImage(targetRelationships[0], "previous-output", 0) }),
    supportingImages: supportingImages.map((relationship, index) =>
      relationshipImage(relationship, parameters.supportingImages[index]!.role, index)
    ),
    ...(maskRelationships[0] === undefined
      ? {}
      : {
          mask: {
            image: {
              source: "artifact",
              artifactId: maskRelationships[0].artifactId!
            },
            targetSlot: 0 as const
          }
        })
  };
}

export function createLibraryRetryHandoff(asset: LibraryAssetDetail): LibraryCreationHandoff {
  const parameters = asset.effectiveParams;
  const inputs = retryInputs(asset);
  const draft: CreationDraft = {
    mode: parameters.kind,
    prompt: parameters.prompt,
    references: inputs.references,
    ...(inputs.target === undefined ? {} : { target: inputs.target }),
    supportingImages: inputs.supportingImages,
    ...(inputs.mask === undefined ? {} : { mask: inputs.mask }),
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
  const primary = asset.renditions.find(
    (rendition) => rendition.artifactId === asset.primaryArtifactId
  );
  if (primary === undefined || primary.phase === "source") {
    handoffFailure("edit-again requires a selected output artifact");
  }
  return {
    action: "edit",
    assetId: asset.id,
    draft: {
      mode: "edit",
      prompt: parameters.prompt,
      references: parameters.references.map((reference, index) =>
        parameterAssetImage(
          reference.assetId,
          reference.role,
          reference.label,
          `library-edit-reference-${index}-${reference.assetId}`
        )
      ),
      target: {
        id: `library-edit-target-${asset.id}-${asset.primaryArtifactId}`,
        role: "previous-output",
        locator: { source: "artifact", artifactId: asset.primaryArtifactId }
      },
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
      (image) =>
        image.locator !== undefined &&
        studioImageInputRefSchema.safeParse(image.locator).success &&
        image.upload === undefined &&
        image.resource === undefined
    ) &&
    handoff.draft.maskUpload === undefined &&
    (handoff.draft.mask === undefined ||
      (handoff.draft.mask.targetSlot === 0 &&
        studioImageInputRefSchema.safeParse(handoff.draft.mask.image).success))
  );
}
