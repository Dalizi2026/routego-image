## Context

The public `routego_generate` schema currently applies hard-coded field defaults before `ProductionLocalRoutegoService` reads the active profile. As a result, a request with omitted controls becomes `auto`/PNG/one output rather than inheriting the durable Studio defaults. Separately, Creation correctly records the provider-detected MIME, but Library ingestion rejects any output whose bytes differ from `effectiveParams.format`. A provider that ignores a requested PNG format and returns valid JPEG therefore produces a final artifact that cannot be committed.

This change spans the shared public-input schema, Integration composition, Library ingestion, and their contract tests. Existing seven-tool names, Studio request shapes, provider routes, Library index schema, and user configuration remain frozen dependencies.

## Goals / Non-Goals

**Goals:**

- Preserve whether public generation controls were omitted until Integration resolves them from the active durable defaults.
- Record the caller's resolved settings in `requestedParams` and the provider/executor-selected settings in `effectiveParams` without relabeling returned image bytes.
- Persist any validated PNG, JPEG, or WebP output using its detected MIME and extension, even if it differs from the requested format.
- Keep persistence failures atomic, sanitized, truthful, and independently testable.

**Non-Goals:**

- Do not change Studio's explicit generation request contract or settings UI.
- Do not infer unsupported provider capabilities, transcode provider images, retry billable requests, migrate existing Library data, or alter the seven public tools.
- Do not weaken byte, hash, dimension, lock, journal, or atomic-commit validation.

## Decisions

### Preserve public input omission until Integration resolves defaults

`routego_generate` and batch-item public input schemas already accept optional generation controls at their MCP/HTTP boundary, even though their parsed operation value carries compatibility defaults. Integration will inspect property presence on the original public payload, read the active profile's durable default snapshot once per operation/batch, merge only omitted controls, then validate the completed `ImageOperationRequest` before preflight and execution. Explicit values, including `auto`, remain caller choices.

This preserves the frozen public wire schema and is preferred over treating all `auto` values as omissions, which would make an explicit caller override indistinguishable from an omitted value. It is also preferred over moving configuration reads into Creation because Creation must remain independent of persisted configuration.

### Separate requested settings from returned binary facts

The resolved request remains the requested/effective parameter record for provider submission. Creation's validated artifact MIME, dimensions, byte length, and SHA-256 remain authoritative facts about the returned binary. The system will not rewrite effective request parameters to make them match a provider that ignored an output-format preference.

### Remove the false format-equality gate at Library ingestion

Library ingestion will continue validating every source file against the expected detected metadata supplied by Integration. It will permit an output MIME different from `effectiveParams.format` only when Integration supplied an expected detected MIME and byte-validation has confirmed that claim. Direct/unverified Library inputs retain the existing effective-format equality gate. Blob publishing already chooses the extension from detected MIME, so this preserves atomic ingestion and correct filenames without a data model migration.

Rejecting a valid JPEG merely because the request asked for PNG is unsafe: it loses a paid result and conflicts with the response-normalization contract. Transcoding would be a different product feature with quality, cost, and transparency implications, so it is excluded.

### Surface durable defaults through an explicit Integration resolver

The resolver will be a narrow Integration helper with unit coverage. It will accept the parsed public override shape and the defaults obtained from the existing settings owner, produce a frozen complete operation request, and be used by both single and batch public paths. Studio paths keep their explicit request flow unchanged.

## Risks / Trade-offs

- [Public-schema optionality affects MCP input typing] → Add contract tests that prove omitted controls resolve to profile defaults while explicit controls override them.
- [A provider can still ignore requested size or format] → Preserve the discrepancy truthfully in artifact metadata; do not claim unsupported capability states.
- [Removing the MIME equality gate could hide malformed files] → Retain exact source-byte validation against Integration's detected MIME, dimensions, size, and SHA-256 before any publish.
- [Library commit failure after a provider result] → Keep the existing partial result and sanitized persistence error; do not retry or fabricate a saved asset.

## Migration Plan

1. Add the override schema and Integration default resolver with focused tests.
2. Update public single and batch composition to resolve defaults before creation execution.
3. Remove the Library request-format equality check while retaining detected-byte validation, then add JPEG-from-PNG regression coverage.
4. Run contract, unit, integration, build, and plugin-package validation; create a cachebuster update and reinstall from the existing local marketplace.
5. Roll back by reverting the implementation commit. No stored settings, credentials, Library records, or migrations are changed.

## Open Questions

None. The current active defaults and the failed request provide sufficient evidence for this bounded repair.
