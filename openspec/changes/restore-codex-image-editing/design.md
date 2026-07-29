## Context

Routego Image can generate images and can use reference images for generation, but the public Codex conversation surface no longer exposes an executable image-editing operation. The shared schemas retain portions of the old edit model and the previous Creation implementation retained an audited multipart request path in Git history, while the current public operation registry intentionally rejects edit input.

The requested feature is a main-conversation capability only. The user supplies one target image, a change instruction, optional reference images, and explicit preservation conditions. Routego must continue to use its existing local input validation, request staging, provider execution, response materialization, and Library persistence flow. The configured provider may only offer a legacy single generation endpoint; it must never be assumed to expose an OpenAI Edits or Responses endpoint.

The reference project `CookSleep/gpt_image_playground` demonstrates the relevant protocol pattern: an OpenAI Images edit uploads the target image and optional supporting images as multipart data. Routego will adopt that protocol shape where explicitly configured, rather than copying the reference project's UI or application structure.

## Goals / Non-Goals

**Goals:**

- Add a validated `routego_edit` MCP and loopback HTTP operation for a target image, edit prompt, up to five ordered reference images, and non-empty edit invariants.
- Restore target/reference preparation, compatible provider routing, standard OpenAI Images multipart Edits serialization, and current legacy JSON image-input compatibility without disturbing text generation.
- Reuse the existing Integration lifecycle for durable result materialization, input/output relationships, Library persistence, cancellation, and structured errors.
- Permit the user-approved first explicit edit request to establish compatibility evidence for its selected, configured route without sending a second probe.
- Preserve the no-replay billing guard: one failed provider submission never switches transport automatically.

**Non-Goals:**

- No Studio edit page, reference-image panel, upload surface, mask editor, or Studio creation-workflow change. The existing Provider profile form may store an exact optional Edits endpoint, but must never derive it from the generation endpoint.
- No batch edit support, mask support, automatic capability probes, derived provider endpoints, external service deployment, or new runtime dependency.
- No changes to the existing generation defaults, generation tool schema, Library UI, saved assets, output-directory policy, or provider credentials.

## Decisions

### Separate public edit operation

`routego_edit` remains separate from `routego_generate` and `routego_batch`. Its schema has a discriminated `kind: "edit"`, a required target, references limited to five, and invariants that must contain at least one preservation or change statement. This keeps the regular generation contract stable and makes an edit intent unambiguous at MCP, HTTP, routing, persistence, and audit boundaries. Batch remains generation-only because a multi-item edit request would compound input selection and billing risk.

Alternative considered: adding optional edit fields to `routego_generate`. Rejected because a missing target or invariant could silently turn a requested edit into unrelated generation.

### Reuse the single operation lifecycle

Integration's public execution flow will prepare the target and references, stage them into the request transaction, call Creation once, materialize returned outputs, and persist the same graph and relationships used by generation. Target and references become durable graph inputs, with the target first. This prevents a second result-saving path and preserves the existing Library semantics.

Alternative considered: writing edit files directly from Creation. Rejected because it would bypass output validation, atomic materialization, Library relationships, and error accounting.

### Explicit provider route tiers

Tier A uses only the configured generation endpoint and sends validated image data URLs in its already-supported `image` or `images` JSON shapes. Tier B uses OpenAI Images generation JSON for text-only generation and uses multipart only with an explicitly configured Edits endpoint: the target is `image`, additional ordered references are `image[]`. Tier C uses the explicitly configured Responses endpoint only when that endpoint and the required capability scope are available. No code derives sibling endpoints.

The existing Provider settings form may accept that exact optional Edits endpoint alongside its existing optional Models and Responses endpoints. It is deliberately not populated from a generation endpoint or API base: a user must enter the provider-supplied value, and a stored endpoint with hidden query data requires full re-entry before it may be saved.

Alternative considered: always post to `/images/edits`. Rejected because a configured legacy base does not prove that endpoint exists and could direct user data to a wrong service.

### Explicit edit is the capability-establishing request

The routing context identifies a direct `routego_edit` execution. When the user has explicitly authorized that request, an otherwise unknown capability record for the selected configured image-input route does not block that one request. A successful result records sanitized supported evidence scoped to provider, model, endpoint fingerprint, transport, and request shape. A failure remains a truthful failure; it is not converted into support and is never retried on another protocol. Automatic work and image-input generation retain their existing requirement for verified evidence.

Alternative considered: require a separate paid capability probe. Rejected because the requested edit itself is the approved useful operation and a probe would add cost and duplicate image handling.

### Preserve target image dimensions by default

The edit tool defaults `size` and `aspectRatio` to `auto`. Integration's configured global generation dimensions are not injected into an edit, so an image edit is not reshaped to a generation-oriented banner size. Explicit user output controls continue to be validated normally.

## Risks / Trade-offs

- [A relay accepts generation JSON but rejects image input] -> Return the provider's sanitized error, preserve billing risk, and do not generate an unrelated image or try multipart automatically.
- [A relay accepts a multipart request with more than one image differently] -> Preserve deterministic target-first ordering, bound references to five, test serialized field order, and report the returned result honestly.
- [The first approved edit can incur a charge] -> Make one submission only, retain `mayHaveBilled` state, and do not run a preliminary capability probe.
- [Existing working-tree changes touch routing and provider serialization] -> Apply the edit additions around the current code rather than restoring historic files wholesale, and run focused regression tests for generation routes.
- [Target/input paths are transient] -> Stage validated inputs into the existing request transaction before provider execution and persist relationships through the existing graph projector.

## Migration Plan

1. Add the public schema, operation registry entry, service method, and focused contract tests.
2. Restore target/reference preparation, selected-route serialization, and route selection without changing generation request shapes.
3. Extend Integration source staging and MCP output projection to carry edit results through existing persistence.
4. Run type checks, package tests, build/package validation, and only then refresh the local plugin package.
5. Submit the user's explicitly authorized wardrobe-change request exactly once through `routego_edit`, retaining the result or structured failure as the actual acceptance outcome.

Rollback is a forward patch removing `routego_edit` from the registry while leaving existing generate, batch, Studio, and Library data untouched. No data migration is needed.

## Open Questions

- The configured relay's image-input request shape is not yet evidenced. The first user-approved edit will establish only the selected route's scoped evidence; it will not infer support for sibling endpoints or input counts.
