> **NON-FROZEN DRAFT — DEPENDENCY GATE ACTIVE**
>
> This proposal is preserved for planning continuity only. It MUST NOT be treated as an approved capability set, used to create frozen design/spec/task artifacts, or applied until the Program Controller confirms that the Foundation Extension baseline is complete and Creation has rebased or integrated that baseline.

## Why

Routego Image has frozen shared contracts and provider-routing rules, but it still lacks the production Creation layer that can turn validated generate/edit requests into safe provider calls and expose the resulting service through MCP and loopback HTTP. This change supplies that layer while preserving the user's real baseline: one configured generation endpoint and API key, with image input, Edits, and Responses remaining unavailable until explicit evidence confirms them.

## What Changes

- Add production adapters for the configured single-endpoint JSON protocol, explicitly configured OpenAI Images generations/Edits, and explicitly configured Responses image-generation requests.
- Add ordered local image-input preparation for reference images, edit targets, supporting images, and masks without persisting user images or changing Library-owned data.
- Add synchronous JSON, Base64, result-URL, and Responses SSE parsing that preserves partial/final artifacts, provider identifiers, billing risk, and sanitized failures.
- Add same-transport retry decisions and deadlines that retry only eligible pre-generation 429/5xx failures, never replay across transports, and never automatically retry after output or possible billing.
- Add image operation execution for generate, edit, degraded continuation, multi-variant results, and bounded batch orchestration with explicit partial success.
- Add production `RoutegoService` generation/edit/batch behavior plus MCP and protected loopback HTTP adapters that share the frozen operation schemas and validate both input and output.
- Add deterministic offline contract, failure, security, and transport tests against Foundation's mock relay fixtures.
- Keep provider capabilities evidence-driven: text generation is the only default route; image input, Edits, Responses, sibling endpoints, streaming, and multi-image support remain `unknown` unless configuration or successful evidence authorizes them.

### Non-goals

- No Library configuration, persistence, asset index, favorites, trash, ZIP, or permanent image-storage implementation.
- No Studio pages, components, browser journeys, mask-editor UI, plugin manifest, packaging, marketplace, installation, deployment, or release workflow.
- No real provider probe, real API key, paid validation, automatic `/models`/`images/edits`/`responses` URL derivation, or modification of the legacy plugin/config/library.
- No change to Foundation-owned shared schemas, root dependencies, lockfile, workspace configuration, mock relay implementation, or public security/provider contracts.

## Capabilities

### New Capabilities

- `provider-operation-adapters`: Request construction and explicit capability-gated dispatch for single-endpoint JSON, OpenAI Images, Edits multipart, and Responses image generation.
- `provider-response-processing`: Safe parsing of JSON, Base64, result URLs, and Responses SSE into structured final/partial artifacts and sanitized failures.
- `image-job-execution`: Generate, edit, continuation, retry, variant, and bounded batch orchestration using the frozen Routego service contracts.
- `creation-runtime-transports`: Production generation/edit/batch service composition plus schema-validating STDIO MCP and protected loopback HTTP adapters.

### Modified Capabilities

None. Foundation specifications and exported contracts remain frozen dependencies.

## Impact

- Adds Creation-owned implementation and tests under new runtime package directories; it consumes `@routego-image/contracts` and `@routego-image/foundation` without copying or changing them.
- Implements the generate/edit/batch portions of the frozen `RoutegoService`; Library and Studio operations remain dependency-injected implementations owned by their respective lanes.
- Exposes the frozen MCP tool names and `/api/v1/*` routes through production adapters while retaining input/output validation, loopback/session/origin protections, and sanitized errors.
- Adds no new root dependency or native runtime dependency and does not alter the plugin manifest, release artifacts, user configuration, or user image library.
