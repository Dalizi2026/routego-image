## Context

Routego Image 1.0 is being rebuilt as three runtime layers: a Codex Skill, one local application service exposed through STDIO MCP and loopback HTTP, and Routego Studio. The repository currently contains planning documents only. Three downstream lanes will begin after Foundation is merged, so shared request shapes, provider evidence, service errors, security rules, and mock behavior must be frozen before those lanes write code.

The user's only guaranteed provider inputs are one configured image-generation endpoint and one API key. The legacy plugin normalizes an API base to a generations URL and sends image data URLs to that same JSON endpoint for reference/edit workflows. `/images/edits`, `/responses`, `/models`, streaming, and image input are not guaranteed. Foundation must model those possibilities without probing a real provider or claiming support.

Foundation owns shared schemas, root workspace configuration, mock contracts, security primitives, test infrastructure, and provenance/compatibility records. Creation owns production provider adapters, task execution, retries, STDIO MCP, and HTTP runtime implementation; Library owns persistence; Studio owns UI and browser journeys.

Two completed pre-change audits are binding evidence for this design. The legacy audit (`docs/audits/legacy-plugin-audit.md`, `LA-01` through `LA-10`) verified the Tier A JSON shapes, the optional single `image` data URL, variant/batch inconsistencies, unsafe endpoint derivation, bearer forwarding to arbitrary result URLs, incomplete timeouts, and Windows forced-exit failure. The upstream audit (`docs/audits/gpt-image-playground-reuse.md`) pins `CookSleep/gpt_image_playground` at `a10477581b3d43ac98d39777e4445625a9db113d`, confirms MIT attribution to CookSleep, and limits reuse to selected pure logic and fixtures rather than the application architecture.

## Goals / Non-Goals

**Goals:**

- Create a cross-platform pnpm workspace using Node.js 20.19+, TypeScript strict mode, ESM, Zod, Vitest, Playwright-ready browser testing, and pure-JavaScript build tools.
- Publish one browser-safe contracts package containing runtime schemas and inferred types for all seven public tool boundaries and their shared image/provider/error primitives.
- Publish a Node foundation package containing provider routing decisions, safe diagnostics, loopback/session/origin policy, and path-containment primitives.
- Provide a deterministic mock relay that represents text-only single-endpoint, image-capable single-endpoint, explicitly configured Images API, and explicitly configured Responses API fixtures.
- Freeze the dependency surface that Creation, Library, and Studio consume.
- Incorporate the completed audit evidence, exact upstream SHA, MIT license, and legacy `FZ-01` through `FZ-12` recommendations into frozen contracts and compatibility records.

**Non-Goals:**

- Production network calls, automatic provider probing, paid tests, retry orchestration, image processing, persistence, Studio UI, plugin packaging, installation, deployment, or marketplace changes.
- Deriving unconfigured endpoint URLs or treating endpoint strings/model lists as proof of image, Edits, or Responses support.
- Reading API keys, copying user images, or modifying/migrating the legacy plugin and its data.

## Decisions

### 1. Workspace and package boundaries

The root workspace will contain three Foundation-owned packages:

- `packages/contracts` (`@routego-image/contracts`): browser-safe Zod schemas, inferred types, public tool names, HTTP route identifiers, and service interface types. It MUST NOT import Node built-ins.
- `packages/foundation` (`@routego-image/foundation`): pure provider selection plus Node-only security/path helpers. It depends on contracts but contains no real provider transport.
- `packages/mock-relay` (`@routego-image/mock-relay`): deterministic Web API request handling and an optional loopback test server used by non-browser contract tests. It records only sanitized request shapes.

Root commands will cover `build`, `typecheck`, `test`, and repository safety checks, while providing Playwright configuration for the Studio lane without owning Studio browser tests. Packages build to ESM plus declarations with `tsup`; TypeScript project references and package exports prevent downstream source duplication. Runtime dependencies remain pure JavaScript.

Alternative considered: one package for everything. Rejected because Studio must import contracts without pulling Node APIs, while service-side security and filesystem rules require Node capabilities.

### 2. Shared contract surface

Zod schemas will be the source of truth. The contracts package will export schemas and inferred types for:

- image operation inputs, references, edit targets, invariants, output options, moderation, continuation, batch limits, and input/output relationships;
- provider protocol tiers, exact-versus-legacy endpoint input semantics, independently optional models/edits/responses endpoints, capability names, four-state values, evidence, timestamps, and redacted endpoint descriptors;
- structured service errors and result envelopes, including partial success, `degradedContinuation`, provider request/attempt counts, `receivedAnyOutput`, and `mayHaveBilled`;
- inputs/results for `routego_status`, `routego_generate`, `routego_edit`, `routego_batch`, `routego_search_library`, `routego_manage_library`, and `routego_open_studio`;
- transport-neutral operation identifiers and the corresponding loopback HTTP route metadata.

Cross-field validation will reject ambiguous edit requests, more than 16 references, invalid count/concurrency/batch ranges, invalid compression, and masks without a target image. File existence, mask dimensions/alpha, and true absolute-path checks remain service responsibilities because the browser-safe package cannot access the filesystem.

Alternative considered: OpenAPI/JSON Schema as the primary source. Rejected for Foundation because MCP, HTTP, Studio, and service code all need the same runtime parser and inferred TypeScript types; JSON Schema may be generated later from Zod if packaging requires it.

### 3. Provider capability and routing model

Provider protocol and endpoint input semantics are explicit:

- `single-endpoint-json` (Tier A): the configured exact generation endpoint; text generation is the only default route. Image data URL support is a separate capability.
- `openai-images` (Tier B): generations plus an explicitly configured/verified edits endpoint.
- `openai-responses` (Tier C): an explicitly configured/verified Responses endpoint and image-generation tool behavior.

Endpoint configuration distinguishes `exact-generation-endpoint` from `legacy-api-base`. Only the latter may append `/v1/images/generations` according to the audited old-plugin rule. `modelsEndpoint`, `editsEndpoint`, and `responsesEndpoint` remain independent and optional; none is derived automatically. Endpoints accept only HTTP(S), reject URL userinfo, redact query/fragment data, and reject non-loopback cleartext HTTP.

Every provider/model/endpoint capability record uses `unknown | supported | unsupported | degraded` and includes evidence source and validation time. Authentication errors, rate limits, timeouts, 5xx responses, moderation blocks, and isolated model failures do not create `unsupported` evidence. A pure routing function selects only a configured route whose required capabilities are `supported` or explicitly `degraded`; otherwise it returns `capability_unavailable` without a network instruction.

Foundation contains no live probe. A future paid probe must carry explicit user confirmation. No route may be silently switched after a timeout, rate limit, 5xx, or partial result.

Alternative considered: derive `/images/edits` and `/responses` from the configured base. Rejected because it violates the verified user environment and can cause unsupported or billable requests.

### 4. Transport-neutral application boundary

The contracts package defines a `RoutegoService` interface for the seven public operations. MCP tool names and `/api/v1/*` route metadata map to the same operation identifiers and schemas. Future adapters must parse input before calling the service and validate service output before serialization.

The Foundation mock service implements the same interface with deterministic results. The mock relay separately emulates upstream provider shapes. This distinction lets Studio mock the application service while Creation tests provider adapters without either lane owning the other's code. The service boundary also rejects legacy stdout marker and short-lived `process.exit()` protocols so successful results cannot be replayed solely because a wrapper observed an abnormal process exit.

Alternative considered: implement production MCP/HTTP servers now. Rejected because AGENTS.md assigns transport runtime implementation to Creation; Foundation only freezes boundaries and test doubles.

### 5. Mock relay modes

The mock relay uses Node 20 Web API objects (`Request`, `Response`, `FormData`) and supports explicitly selected fixtures:

- text-only single endpoint;
- single endpoint accepting `image` or `images` data URLs;
- standard Images generations/edits behavior;
- Responses JSON/SSE-shaped behavior.

Unconfigured paths return a protocol-level not-found response. The default fixture exposes only the single generation endpoint. Request observations contain method, pathname, content type, redacted headers, and a sanitized body shape; they never retain authorization values or image bytes. Synthetic tiny image data is generated in memory for deterministic outputs.

### 6. Security boundaries

Security helpers live outside the browser-safe contracts package:

- recursive diagnostics redaction normalizes key names and removes API keys, authorization/cookie headers, bearer values, session tokens, credential-bearing endpoint query/fragment data, and image data payloads;
- loopback binding accepts only `127.0.0.1` or `::1`; public/wildcard bind addresses are rejected;
- session tokens use cryptographically secure random bytes, are compared in constant time, and are never included in normal logs;
- HTTP policy permits only matching loopback origins, emits no wildcard CORS policy, uses no cookie authentication, and requires the session token for protected operations;
- path helpers resolve and verify containment before later lanes read/write files, reject traversal and NUL input, and never delete or overwrite legacy paths;
- download policy defaults to no provider authorization on result URLs, requires explicit same-origin policy before any credential reuse, and requires each redirect target to be revalidated by Creation;
- a repository safety check rejects likely committed secrets, authorization headers, user-image fixtures, generated outputs, local configuration, and cache/report directories.

Alternative considered: native keychain and filesystem-lock dependencies. Rejected for 1.0 Foundation because native addons conflict with portable packaging; restricted config-file permissions and lock/atomic-write behavior belong to Library.

### 7. Error handling

All boundaries use a structured error with a stable code/category, stage, safe user message, HTTP/provider code when safe, retry disposition, optional capability, sanitized details, partial artifacts, `receivedAnyOutput`, and `mayHaveBilled`. Frozen codes include configuration missing/corrupt, invalid input/response, capability unavailable, authentication, rate limit, timeout, provider 5xx, moderation blocked, download, post-process, and file-write failures. Provider-specific failures remain distinguishable without exposing request headers or raw bodies.

The boundary never returns false success. Partial success is represented by an explicit status and per-item results/errors.

### 8. Verification and provenance

Vitest covers Zod contracts, cross-field validation, capability state transitions, routing, redaction, endpoint normalization, download credential policy, loopback/origin/session policy, path containment, UTF-8/Chinese/emoji/path fixtures, service dispatch, and every mock relay mode. Foundation supplies Playwright configuration only; Studio owns browser tests. CI runs install, safety, typecheck, build, and unit/contract tests on Windows, Ubuntu, and macOS with Node 20.19+.

Foundation records `CookSleep/gpt_image_playground` commit `a10477581b3d43ac98d39777e4445625a9db113d`, `Copyright (c) 2026 CookSleep`, and the full MIT text in `THIRD_PARTY_NOTICES.md` plus `licenses/gpt_image_playground-MIT.txt`. The compatibility record maps the legacy audit's `FZ-01` through `FZ-12` into contracts/tests and explicitly retires the old CLI path assumptions, unsafe key argument, bearer-forwarding downloader, forced `process.exit()`, and unconditional endpoint derivation.

### 9. Directory ownership and frozen dependencies

Foundation exclusively owns during this change:

- root package manager, lockfile, TypeScript/build/test configuration, root scripts, CI, and repository safety configuration;
- `packages/contracts/**`, `packages/foundation/**`, and `packages/mock-relay/**`;
- Foundation contract/security/mock test directories and root Playwright configuration (Studio owns browser test files);
- Foundation provenance, compatibility, and third-party notice documents;
- this change's OpenSpec artifacts and `tasks.md`.

After merge, exported schemas, tool/route identifiers, provider states, error codes, and service interfaces are frozen dependencies for Creation, Library, and Studio. Any requirement-level change must update OpenSpec before code changes. Downstream lanes may add implementations in their owned directories but may not fork or copy the contracts.

## Risks / Trade-offs

- [The initial shared schema may be too rigid for downstream discoveries] → Keep provider-specific data behind sanitized extension records, test browser/service consumers, and require OpenSpec updates for normative changes.
- [Zod and TypeScript package versions can diverge across lanes] → Use a single root lockfile and workspace protocol dependencies owned by Foundation/Integration.
- [Mock behavior can be mistaken for provider proof] → Mark all mock evidence as synthetic and prohibit it from setting production capability state.
- [Windows and POSIX path semantics differ] → Test containment with both path modules and reject ambiguous cross-root input.
- [Audited upstream logic may carry hidden application assumptions] → Pin the exact SHA, copy only approved pure logic later, preserve attribution, and reject upstream application/store/build architecture.
- [Playwright increases install size] → Keep it development-only as shared configuration; Studio owns all browser test files and journeys.

## Migration Plan

1. Build and validate Foundation entirely on `codex/routego-foundation`.
2. Keep the completed audit documents immutable as evidence and map their conclusions into specs, tests, provenance, and compatibility records.
3. Run root safety checks, typecheck, build, Vitest, and strict OpenSpec validation; Studio validates the shared Playwright configuration when its browser suite is added.
4. Merge Foundation into the controller's integration baseline and freeze public exports before Creation, Library, and Studio begin apply.
5. There is no runtime deployment or data migration in this change. Rollback is a normal Git revert of the Foundation merge; legacy plugin files and local user data remain untouched.

## Open Questions

None for Foundation. Real relay support for Tier A image fields, Tier B multipart dialects, Tier C IDs/SSE, and complex transparency remains intentionally unknown until later user-confirmed integration tests; the contracts represent those unknowns rather than resolving them by assumption.
