## Why

Routego Image now has frozen public and browser-safe contracts, but it still lacks the production Creation layer that turns validated internal image requests into safe provider calls and exposes the composed service through Codex MCP and local runtime adapters. This change implements that layer while treating one configured generation endpoint and API key as the only default provider capability.

## What Changes

- Add production request adapters for the configured single-endpoint JSON protocol, explicitly configured OpenAI Images generations/Edits, and explicitly configured Responses image-generation requests.
- Prepare ordered local inputs for public or Integration-resolved `ImageOperationRequest` values, including reference roles, target-first edit ordering, supporting images, and mask validation without resolving Studio asset/upload locators or persisting Library data.
- Parse synchronous Images/Responses JSON, Base64 results, safe result URLs, and Responses SSE into structured final/partial artifacts, provider identifiers, billing/output flags, and sanitized errors.
- Execute generate, edit, explicit degraded continuation, native or same-transport fan-out variants, and bounded ordered batches while reporting the true attempt and provider-request counts.
- Apply staged deadlines and same-transport retry rules: only eligible pre-generation 429/5xx failures receive at most two automatic backoff retries; timeout, authentication, moderation, partial-output, billing-risk, and cross-transport replay remain non-automatic.
- Add schema-validating STDIO MCP and reusable loopback HTTP/JSON/SSE runtime adapters. MCP exposes exactly the seven frozen public tools; HTTP dispatches the frozen public and Studio operation registries against injected service implementations.
- Add an explicit execution seam for Integration: Creation executes already resolved internal image requests, while Integration composes Library/upload locator resolution, artifact persistence/browser-resource projection, and the final `LocalRoutegoService`.
- Add deterministic offline tests against Foundation mock relay fixtures for request shapes, response formats, failures, retry safety, batching, MCP, HTTP, SSE, redaction, and boundary validation.

### Non-goals

- No Studio `assetId`/`artifactId`/`uploadResourceId` filesystem resolution, upload staging or binary upload route, Library configuration/index/persistence, output-resource projection, favorites, trash, or ZIP implementation.
- No real capability probe, automatic sibling endpoint derivation, real API key, paid validation, or claim that image input, Edits, Responses, streaming, multiple images, or native variants are supported without evidence.
- No Studio UI, browser journey, mask editor, plugin manifest, packaging, marketplace, installation, deployment, release, or legacy data migration/modification.
- No changes to Foundation-owned shared schemas, provider/security helpers, mock relay implementation, root dependencies, lockfile, workspace configuration, Library/Studio files, or the seven public MCP operations.
- No chromakey pixel post-processing or Library file persistence; those remain downstream composition concerns while Creation preserves effective parameters and structured post-process boundaries.

## Capabilities

### New Capabilities

- `provider-operation-adapters`: Capability-gated request preparation and dispatch for single-endpoint JSON, OpenAI Images generations/Edits multipart, and Responses image generation.
- `provider-response-processing`: Safe JSON/Base64/URL/SSE normalization into structured artifacts, events, identifiers, and sanitized failures.
- `image-job-execution`: Generate/edit/continuation/variant/retry/batch orchestration over resolved internal requests with honest partial and billing semantics.
- `creation-runtime-transports`: Schema-validating STDIO MCP and reusable loopback HTTP/JSON/SSE adapters over injected `RoutegoService`/`LocalRoutegoService` implementations.

### Modified Capabilities

None. The six Foundation main specifications, shared contracts, and public operation surface remain frozen dependencies.

## Impact

- Product implementation and tests are limited to `packages/creation/**`; this change also owns only its own OpenSpec artifacts.
- The package consumes `@routego-image/contracts` and `@routego-image/foundation` through the prebuilt workspace importer and adds no third-party or native runtime dependency.
- Creation exports provider/execution/runtime primitives and the resolved-request executor that Integration will compose with Library/upload resolution and artifact persistence.
- Public MCP tool names and path-based public contracts remain unchanged; Studio path-free contracts are validated and dispatched but their locator resolution and browser-resource projection are not implemented in this lane.
