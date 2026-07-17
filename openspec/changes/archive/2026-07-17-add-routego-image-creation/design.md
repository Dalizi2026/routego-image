## Context

Foundation, Foundation Extension, and Browser Boundary have frozen the shared Zod contracts, provider tiers, routing decisions, security helpers, deterministic mock relay, seven public MCP operations, path-free Studio operations, upload lifecycle, and downstream package importers. Creation starts from the existing private `@routego-image/creation` package with only workspace dependencies on contracts and Foundation.

The only provider capability guaranteed by default is text generation through the configured generation endpoint. Image data URL input, multiple images, `/images/edits`, `/responses`, streaming, native variants, output controls, moderation, and native transparency remain scoped `unknown | supported | unsupported | degraded` capabilities. A configured exact endpoint is not an API base; only explicit `legacy-api-base` mode may apply the audited generations normalization rule.

Creation owns provider request/response adapters, resolved image-task execution, retry and batch orchestration, and reusable MCP/HTTP runtime adapters. It does not own provider configuration persistence, Studio locator resolution, upload storage, Library paths/indexes, browser-resource projection, Studio UI, plugin assembly, or release. Integration resolves Studio `assetId`/`artifactId`/`uploadResourceId` locators through Library/upload ownership, constructs an internal path-based `ImageOperationRequest`, calls Creation, persists/projects artifacts, and composes the final `LocalRoutegoService`.

Frozen dependencies include `packages/contracts/**`, `packages/foundation/**`, `packages/mock-relay/**`, all six main specifications, root dependencies/lockfile/workspace configuration, and the exact seven public MCP operations. Product edits are limited to `packages/creation/**` and this change's OpenSpec artifacts.

## Goals / Non-Goals

**Goals:**

- Implement safe, capability-gated Tier A/B/C provider requests without guessing sibling endpoints.
- Validate and serialize ordered image inputs and masks for public or Integration-resolved internal requests.
- Normalize synchronous and streaming provider outputs into the frozen structured result semantics.
- Implement truthful variants, retry, continuation, deadline, cancellation, and ordered batch orchestration.
- Provide reusable STDIO MCP and loopback HTTP/JSON/SSE adapters that validate both sides of dispatch and preserve the public/Studio registry split.
- Keep credentials, image bytes, paths, provider bodies, and session values out of diagnostics and test fixtures.
- Remain dependency-free beyond the approved workspace packages and run on Node.js 20.19+ across Windows, macOS, and Linux.

**Non-Goals:**

- Resolving Studio locators, staging uploads, serving binary upload/resource bytes, writing Library indexes, persisting provider profiles, or selecting output directories.
- Implementing the final `LocalRoutegoService` composition, Studio static assets/UI, browser journeys, plugin manifest, packaging, install, release, or real relay acceptance.
- Automatically probing billable capabilities, deriving `/models`, `/images/edits`, or `/responses`, or treating transient failures as unsupported evidence.
- Adding shared schemas, public MCP tools, third-party dependencies, native addons, or root/lockfile changes.
- Implementing chromakey pixel processing or durable output persistence in this lane.

## Decisions

### 1. Keep all Creation product code inside the existing package

`packages/creation` will be organized into provider, execution, and runtime modules:

- `src/provider/**`: resolved input reading/validation, Tier A/B/C serialization, fetch submission, response/download parsing, SSE codec, and provider-error normalization;
- `src/execution/**`: effective-parameter planning, variants, retry/deadline/cancellation policy, continuation, single-task execution, batch scheduling, and event publication;
- `src/runtime/mcp/**`: STDIO JSON-RPC/MCP lifecycle, tool schemas, tool dispatch, result content, and framing;
- `src/runtime/http/**`: loopback server/dispatcher, session/origin/CORS policy application, JSON operations, SSE serialization, and extension hooks for Integration-owned binary/resource handlers;
- `src/index.ts`: reviewed public exports only.

No new package or root reference is needed. The package manifest may add test/build scripts or workspace-only metadata but MUST NOT add a third-party dependency or require a lockfile change.

Alternative considered: separate provider, executor, MCP, and HTTP packages. Rejected because Foundation already froze one Creation importer and the lane cannot modify the root workspace graph or lockfile.

### 2. Use injected runtime context instead of reading persisted configuration

Creation will accept a Node-only runtime context containing the active provider ID/model, frozen endpoint set, scoped capability records, an in-memory API key, optional transport preference, deadline/retry policy, `fetch` implementation, clock/random hooks, and optional event/artifact callbacks. Inputs are parsed at the package boundary; the API key is used only to construct the provider request and is never placed in results, errors, observations, or ordinary logs.

Library or Integration supplies this context from persisted settings. Creation does not read `~/.codex`, environment variables, legacy paths, or Library files implicitly.

Alternative considered: let Creation own configuration loading. Rejected because Library owns configuration persistence and it would create a second secret/data source.

### 3. Execute only resolved internal image requests

Public MCP/server callers may provide path-based `ImageOperationRequest` values directly. Studio callers use frozen path-free contracts; Integration resolves each stable locator and constructs the internal request before calling Creation. Creation never accepts a Studio locator as a filesystem instruction and never queries Library/upload storage.

Resolved local inputs are read without mutation and validated before a provider call:

- regular readable file, bounded size, supported PNG/JPEG/WebP magic and MIME;
- target first, then supporting inputs, then ordered references;
- total physical inputs no greater than 16;
- mask no greater than 50 MiB, PNG with alpha, same dimensions as the target, and bound only to target slot zero;
- invalid or unreadable inputs return structured validation errors with no provider request.

Only small sanitized metadata is retained. Full data URLs and bytes exist only for request construction and are never logged.

Alternative considered: let each adapter read/arrange files independently. Rejected because it would duplicate mask/order/security logic and risk different semantics across transports.

### 4. Treat Foundation routing as authoritative and serialize only the selected route

`selectProviderRoute` decides whether a verified Tier A, B, or C route exists. Creation performs no fallback that contradicts that decision.

- Tier A sends JSON to exactly the normalized configured generation endpoint. Text uses `{model,prompt,n,size}` plus only capability-authorized controls. A single image uses the explicitly evidenced `image` data-URL field; multiple images use the separately evidenced `images` array. Edit target order and optional mask data are stable.
- Tier B sends text-only generation JSON to the configured generation endpoint and uses multipart only when an explicit Edits endpoint and required capabilities are available. Target is the first image part, remaining images preserve order, and mask follows the first target image.
- Tier C sends Responses JSON only to the explicit Responses endpoint, with `image_generation` tool controls, ordered text/image/file/image-ID input, action, and optional previous response state. Streaming is requested only when its capabilities are supported/degraded.

Unknown or unsupported required capabilities return `capability_unavailable` without a network call. Degraded records may be used only with explicit degraded metadata. Authentication, timeout, rate limit, 5xx, moderation, or isolated invalid responses do not mutate capability state inside Creation.

Alternative considered: choose an adapter based on URL shape or retry a sibling route. Rejected because it violates the frozen provider model and can duplicate charges.

### 5. Normalize effective parameters before submission

The execution planner creates one schema-valid `effectiveParams` value before provider submission. It applies provider capability limits and explicit adapter policy without silently reducing quality or changing format. Unsupported requested controls fail before the request; provider defaults remain represented as `auto` rather than invented values.

`count` is handled as follows:

- use one native request with `n=count` only when the scoped route supports native variants and its limit permits the value;
- otherwise, the already user-requested count may fan out into same-transport `count=1` child requests, preserving output slots and reporting the real `providerRequestCount` and per-slot failures;
- fan-out does not establish native-variant support and never crosses transport.

Partial-image requests, native transparency, moderation changes, compression, quality, format, and custom size are sent only when their required scoped capabilities allow them. Chromakey/auto post-processing is not performed here.

### 6. Separate provider codecs from normalized artifacts

Response handling is layered:

1. HTTP status/header classification and bounded body reading;
2. JSON or SSE framing/decoding;
3. Images/Responses shape normalization;
4. Base64 or URL materialization;
5. MIME/magic/size validation and artifact creation;
6. structured result/error assembly.

Images responses accept ordered `data[].b64_json` or `data[].url`. Responses JSON/SSE accepts image-generation call results, provider response/image IDs, partial images, completed items, and explicit failures. Bare Base64 is assigned a MIME only after decoding and validating magic bytes.

Provider result URLs are downloaded with staged deadlines and bounded bytes. Foundation's download policy is evaluated for every initial target and redirect. Authorization is omitted by default and may be forwarded only under explicit same-origin policy; redirects are revalidated. Unsupported protocols, unsafe cleartext destinations, userinfo, invalid MIME/magic, oversize content, and redirect-policy failures become structured sanitized errors.

Creation may return actual provider output as validated display data in the public artifact when no persistence callback is supplied. An injected downstream artifact callback may materialize/persist bytes and replace or augment the path later; Creation does not write Library data itself.

### 7. Preserve partial output and make retries billing-safe

Provider errors are mapped to frozen codes/categories/stages with safe messages and redacted bounded details. Raw bodies, headers, credentials, data URLs, and bytes are never exposed.

Automatic retry uses Foundation's same-transport decision and at most three total attempts:

- eligible only for pre-generation 429 or 5xx with no received output and no billing risk;
- honors a bounded `Retry-After` or exponential backoff;
- never retries authentication, timeout, moderation, validation, cancellation, invalid response after submission, partial output, or possible billing;
- never changes endpoint, transport, model, quality, or request shape.

Connection/response-header, body/stream, download, and total-operation deadlines remain active for their full stages. Timeout does not silently degrade quality or switch transports. Abort signals cancel pending work and prevent new batch items, while already received artifacts are preserved.

### 8. Make continuation and partial results explicit

Responses state is used only when the explicit Responses route and state capabilities are available. If state is unavailable and Integration supplies a resolved previous output with `allowDegradedContinuation`, Creation submits it through a verified Tier A/B image-input route and sets `degradedContinuation=true`. It does not resolve previous asset IDs itself.

Any final/partial artifact is assigned a stable request-local ID and slot. A failure after output returns `partial`, preserves artifacts/relationships, sets `receivedAnyOutput=true` and `mayHaveBilled=true`, and has a non-automatic retry disposition. No empty or invalid provider result is reported as success.

### 9. Use a bounded ordered batch scheduler

Batch validation remains owned by the frozen schema. The scheduler runs at the requested concurrency from 1 through 10, preserves input order and task IDs, isolates each task's errors, and returns one result per item. Overall status is derived honestly from item outcomes. A failed task does not cancel unrelated tasks unless the caller aborts; abort prevents new starts and marks pending items cancelled without discarding completed results.

The same executor handles public batch items and Integration-resolved Studio batch items after locator resolution. Creation does not project browser resources.

### 10. Implement MCP without expanding the public tool surface

The STDIO adapter implements the required JSON-RPC/MCP lifecycle for initialize, tools listing, and tool calls. It derives JSON Schema from the frozen Zod input schemas, advertises exactly the seven `routegoOperationDefinitions`, validates input before dispatch, validates service output after dispatch, and returns sanitized JSON text plus final image content when a validated public artifact contains display data.

Partial images are omitted from ordinary MCP content unless the final structured result itself requires reporting them. The adapter writes protocol messages only to stdout; diagnostics go through an injected sanitized logger on stderr and never force `process.exit()` after a business result.

Alternative considered: add the MCP SDK. Rejected because the Creation importer is frozen to workspace-only dependencies and no lockfile change is authorized.

### 11. Implement reusable HTTP/JSON/SSE runtime primitives, not final cross-lane composition

The HTTP runtime binds only to `127.0.0.1` or `::1`, applies Foundation session/origin/CORS helpers with injected session state, and dispatches registered public or Studio JSON operations by their frozen definitions. It validates both inputs and outputs and fails closed with a sanitized structured boundary error.

GET query decoding is explicit for the registered read operations; POST bodies are bounded UTF-8 JSON. An injected extension handler lets Integration attach upload binary content and protected browser-resource routes without Creation reading their storage. The final `LocalRoutegoService` object is injected by Integration.

Studio creation SSE uses only `studioImageOperationEventSchema`; every event is validated before serialization, uses monotonically increasing sequence values, and preserves billing/output flags. The runtime provides event-broker primitives, while Integration connects resolved Studio execution and persisted browser-resource projections.

Alternative considered: have Creation implement upload storage and locator resolution inside the server. Rejected by PD-004 and the frozen Integration composition boundary.

### 12. Verification and provenance

Vitest will cover serializers, input validation, mask/order rules, Images/Responses JSON, multipart, SSE LF/CRLF/multiline/DONE/errors, safe URL download policy, MIME/magic/size checks, retries/deadlines/cancellation, native/fan-out variants, degraded continuation, ordered batch partials, MCP lifecycle/tool dispatch/image content, HTTP loopback/session/origin/input/output validation, and Studio SSE projections.

Provider contract tests use Foundation's deterministic mock relay through a test-only Vitest alias, without adding a runtime or lockfile dependency. Fixtures contain only synthetic one-pixel images and mock credentials that cannot be mistaken for real data. Upstream-derived SSE/request ideas are rewritten for Routego and remain covered by the existing third-party notice and pinned provenance record.

Every implementation task runs fresh apply instructions, its focused tests, package typecheck, repository safety, diff scope, and `git diff --check`; build/export checks run after public wiring. The final gate runs strict OpenSpec, root safety/typecheck/build/tests/exports, dependency/native audit, exact seven-tool assertions, and Git cleanliness.

## Risks / Trade-offs

- [Risk] Provider-compatible endpoints use different undocumented field dialects. → Mitigation: send only capability-evidenced shapes, keep Tier A single/multiple fields separate, test frozen fixtures, and defer real dialect acceptance to user-confirmed Integration testing.
- [Risk] A request may have been billed before a transport error becomes visible. → Mitigation: mark submitted/partial outcomes as possible billing, restrict automatic retry to conclusive pre-generation 429/5xx, and never cross transports.
- [Risk] Returning display data can be large. → Mitigation: enforce response/download byte limits, omit intermediate images from MCP by default, and let Integration persist/project resources for Studio.
- [Risk] Manual MCP/HTTP implementation can drift from protocols. → Mitigation: isolate codecs, use frozen operation definitions, add framing/lifecycle contract tests, and keep final plugin smoke tests in Integration.
- [Risk] Generic HTTP hooks could blur lane ownership. → Mitigation: hooks accept opaque validated handlers; Creation never imports Library/Studio code or resolves their paths.
- [Risk] Variant fan-out can create multiple billable requests. → Mitigation: it occurs only for the user's requested count, preserves same transport/shape, and reports the true provider request count and per-slot errors.
- [Risk] Native transparency/chromakey requirements are incomplete in this lane. → Mitigation: native mode is capability-gated; chromakey pixel processing remains an explicit downstream integration responsibility and is not falsely reported as completed here.

## Migration Plan

1. Strictly validate and commit the reconciled Creation OpenSpec artifacts.
2. Implement and commit provider input/request adapters, then update only the corresponding task state.
3. Implement and commit response/SSE/download processing, then update task state.
4. Implement and commit execution/retry/variant/batch orchestration, then update task state.
5. Implement and commit MCP and HTTP/JSON/SSE runtime adapters, then update task state.
6. Wire reviewed package exports and run the full Creation regression suite.
7. Run the final strict/root verification and planning-consistency audit, record immutable SHAs, and notify the Program Controller generation 1 thread.
8. Integration later composes provider configuration, locator resolution, artifact persistence/browser projection, upload/resource routes, Studio assets, plugin packaging, and real relay acceptance. Rollback uses `git revert`; no user data is migrated or modified in this change.

## Open Questions

None. The product plan, PD-004, Browser Boundary contracts, lane ownership, dependency policy, and provider defaults fix the required behavior. Any need to change shared contracts, root dependencies, public operations, locator resolution ownership, or acceptance criteria is a `[PLAN_DEVIATION]` and pauses implementation.
