import path from "node:path";

import {
  identifierSchema,
  libraryAssetRelationshipSchema,
  type ImageOperationRequest
} from "@routego-image/contracts";
import type {
  LibraryAssetRenditionInput,
  LibraryRelationship,
  ResolvedStableImageResource
} from "@routego-image/library";

export const MAX_STUDIO_PHYSICAL_IMAGE_INPUTS = 16;
export const MAX_STUDIO_MASK_INPUTS = 1;
export const MAX_STUDIO_SOURCE_RENDITIONS =
  MAX_STUDIO_PHYSICAL_IMAGE_INPUTS + MAX_STUDIO_MASK_INPUTS;

export type StudioPhysicalInputRole = "target" | "reference" | "supporting" | "mask";
export type StudioPhysicalInputKey =
  | "target"
  | "mask"
  | `reference:${number}`
  | `supporting:${number}`;

export type VerifiedStudioImageResource = ResolvedStableImageResource & {
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
};

export interface ResolvedStudioPhysicalInput {
  readonly key: StudioPhysicalInputKey;
  readonly role: StudioPhysicalInputRole;
  readonly order: number;
  readonly resource: VerifiedStudioImageResource;
  readonly referenceRole?: ImageOperationRequest["references"][number]["role"];
  readonly label?: string;
  readonly targetSlot?: 0;
}

export interface PlannedSourceRendition
  extends Required<Pick<LibraryAssetRenditionInput, "artifactId">>,
    Omit<LibraryAssetRenditionInput, "artifactId"> {}

export interface DurableInputGraphItem {
  readonly key: StudioPhysicalInputKey;
  readonly role: StudioPhysicalInputRole;
  readonly order: number;
  readonly origin: "library" | "upload";
  readonly relatedAssetId: string;
  readonly artifactId: string;
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly byteLength: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly relationship: LibraryRelationship;
  readonly referenceRole?: ImageOperationRequest["references"][number]["role"];
  readonly label?: string;
  readonly targetSlot?: 0;
  readonly sourceRendition?: PlannedSourceRendition;
}

export interface DurableInputGraphPlan {
  readonly operationAssetId: string;
  readonly inputs: readonly DurableInputGraphItem[];
  readonly sourceRenditions: readonly PlannedSourceRendition[];
  readonly relationships: readonly LibraryRelationship[];
  readonly physicalImageCount: number;
  readonly maskCount: number;
}

export type InputGraphIdentityKind =
  | "operation-asset"
  | "source-artifact"
  | "relationship";

export type InputGraphIdFactory = (
  kind: InputGraphIdentityKind,
  order: number,
  attempt: number
) => string;

export interface BuildDurableInputGraphOptions {
  readonly idFactory: InputGraphIdFactory;
}

export class DurableInputGraphError extends Error {
  readonly code: "identity-conflict" | "input-limit" | "invalid-input";

  constructor(
    code: DurableInputGraphError["code"],
    message: string
  ) {
    super(message);
    this.name = "DurableInputGraphError";
    this.code = code;
  }
}

function allocateUniqueIdentifier(
  kind: InputGraphIdentityKind,
  order: number,
  used: Set<string>,
  factory: InputGraphIdFactory
): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let generated: unknown;
    try {
      generated = factory(kind, order, attempt);
    } catch {
      throw new DurableInputGraphError(
        "identity-conflict",
        "The deterministic input graph identity allocator failed."
      );
    }
    const candidate = identifierSchema.safeParse(generated);
    if (!candidate.success || used.has(candidate.data)) continue;
    used.add(candidate.data);
    return candidate.data;
  }
  throw new DurableInputGraphError(
    "identity-conflict",
    "A unique deterministic input graph identity could not be allocated."
  );
}

function validateOrderedInputs(inputs: readonly ResolvedStudioPhysicalInput[]): void {
  if (inputs.length > MAX_STUDIO_SOURCE_RENDITIONS) {
    throw new DurableInputGraphError(
      "input-limit",
      "The Studio operation exceeds the bounded physical input capacity."
    );
  }
  const keys = new Set<StudioPhysicalInputKey>();
  const orders = new Set<number>();
  for (const input of inputs) {
    if (
      !Number.isSafeInteger(input.order) ||
      input.order < 0 ||
      input.order > 255 ||
      keys.has(input.key) ||
      orders.has(input.order)
    ) {
      throw new DurableInputGraphError(
        "invalid-input",
        "The resolved Studio input order is invalid or ambiguous."
      );
    }
    keys.add(input.key);
    orders.add(input.order);
    if ((input.role === "mask") !== (input.targetSlot === 0)) {
      throw new DurableInputGraphError(
        "invalid-input",
        "A mask input must bind only to target slot zero."
      );
    }
  }
  const sortedOrders = [...orders].sort((left, right) => left - right);
  if (sortedOrders.some((order, index) => order !== index)) {
    throw new DurableInputGraphError(
      "invalid-input",
      "The resolved Studio input order must be contiguous."
    );
  }
  const physicalImageCount = inputs.filter((input) => input.role !== "mask").length;
  const maskCount = inputs.length - physicalImageCount;
  if (
    physicalImageCount > MAX_STUDIO_PHYSICAL_IMAGE_INPUTS ||
    maskCount > MAX_STUDIO_MASK_INPUTS
  ) {
    throw new DurableInputGraphError(
      "input-limit",
      "The Studio operation exceeds the sixteen-image plus optional-mask boundary."
    );
  }
}

export function buildDurableInputGraph(
  inputs: readonly ResolvedStudioPhysicalInput[],
  options: BuildDurableInputGraphOptions
): DurableInputGraphPlan {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.idFactory !== "function"
  ) {
    throw new DurableInputGraphError(
      "invalid-input",
      "A deterministic input graph identity allocator is required."
    );
  }
  validateOrderedInputs(inputs);
  const ordered = [...inputs].sort((left, right) => left.order - right.order);
  const usedIdentifiers = new Set<string>();
  for (const input of ordered) {
    if (input.resource.source === "upload") continue;
    usedIdentifiers.add(input.resource.assetId);
    usedIdentifiers.add(input.resource.artifactId);
  }
  const factory = options.idFactory;
  const operationAssetId = allocateUniqueIdentifier(
    "operation-asset",
    0,
    usedIdentifiers,
    factory
  );
  const graphItems: DurableInputGraphItem[] = [];
  const sourceRenditions: PlannedSourceRendition[] = [];
  const relationships: LibraryRelationship[] = [];

  for (const input of ordered) {
    const upload = input.resource.source === "upload";
    const artifactId = upload
      ? allocateUniqueIdentifier(
          "source-artifact",
          input.order,
          usedIdentifiers,
          factory
        )
      : input.resource.artifactId;
    const relatedAssetId = upload ? operationAssetId : input.resource.assetId;
    const relationshipId = allocateUniqueIdentifier(
      "relationship",
      input.order,
      usedIdentifiers,
      factory
    );
    const relationship = Object.freeze(libraryAssetRelationshipSchema.parse({
      id: relationshipId,
      role: input.role,
      relatedAssetId,
      artifactId,
      order: input.order,
      ...(input.label === undefined ? {} : { label: input.label })
    }));
    const sourceRendition: PlannedSourceRendition | undefined = upload
      ? Object.freeze({
          artifactId,
          phase: "source",
          sourceRoot: path.dirname(input.resource.path),
          sourceRelativePath: path.basename(input.resource.path),
          requestedBaseName: `${input.role}-${input.order}`,
          expected: Object.freeze({
            mimeType: input.resource.mimeType,
            byteLength: input.resource.byteLength,
            sha256: input.resource.sha256,
            width: input.resource.width,
            height: input.resource.height
          })
        })
      : undefined;
    if (sourceRendition !== undefined) sourceRenditions.push(sourceRendition);
    relationships.push(relationship);
    graphItems.push(Object.freeze({
      key: input.key,
      role: input.role,
      order: input.order,
      origin: upload ? "upload" : "library",
      relatedAssetId,
      artifactId,
      path: input.resource.path,
      mimeType: input.resource.mimeType,
      byteLength: input.resource.byteLength,
      sha256: input.resource.sha256,
      width: input.resource.width,
      height: input.resource.height,
      relationship,
      ...(input.referenceRole === undefined ? {} : { referenceRole: input.referenceRole }),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.targetSlot === undefined ? {} : { targetSlot: input.targetSlot }),
      ...(sourceRendition === undefined ? {} : { sourceRendition })
    }));
  }

  const physicalImageCount = graphItems.filter((input) => input.role !== "mask").length;
  return Object.freeze({
    operationAssetId,
    inputs: Object.freeze(graphItems),
    sourceRenditions: Object.freeze(sourceRenditions),
    relationships: Object.freeze(relationships),
    physicalImageCount,
    maskCount: graphItems.length - physicalImageCount
  });
}
