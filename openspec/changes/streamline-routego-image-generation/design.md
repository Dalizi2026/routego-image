## Context

Routego Image is a pnpm/TypeScript plugin composed of shared Zod contracts, Foundation provider capability/routing, Creation execution, a durable JSON Library, an Integration composition/HTTP/MCP runtime, and a React/Vite Studio. The current system was designed for both generation and editing and therefore carries edit targets, masks, continuation, Trash mutations, variable batch concurrency, and broad workbench controls across every layer.

The confirmed product direction makes the Codex conversation the only full generation entry point. It retains text and one-to-five-reference generation there, while Studio becomes a text-only generation and Library companion. This is a breaking cross-package change and includes a destructive legacy-data migration plus a new portable inference dependency.

Constraints:

- Provider requests can be billable. Capability probes and automatic replay are forbidden unless separately and explicitly initiated by the user.
- Real API keys, user images, configuration, paths, and Library data cannot be read for development.
- No current installation replacement, publication, CI trigger, or real Library migration is authorized.
- U-2-Netp and ONNX Runtime installation/download is a separate authorization gate.
- Windows and Ubuntu real-CI evidence remains owned by the existing `integrate-routego-image-plugin` Task 9.1 and is not absorbed by this change.
- B-01 source tests pass, but the fix still requires verification from a newly built offline-install artifact.

## Goals / Non-Goals

**Goals:**

- Remove editing completely from public tools, HTTP composition, execution, Studio, Library presentation, packaging surface, tests, and documentation.
- Preserve safe text, single-reference, and up-to-five-reference generation through `routego_generate`.
- Make Studio controls and batching match the confirmed simple behavior without changing the established visual language.
- Allow fast, future-request-only provider switching.
- Reduce the Library to viewing, organization, portability, download, comparison, preview, and safe main-conversation regeneration handoff.
- Provide recoverable, approval-bound legacy cleanup rather than silent destructive startup migration.
- Provide bounded local transparency using portable WASM inference and honest fallback outcomes.
- Maintain strict validation, path/secret redaction, cancellation, partial-result honesty, and package verification.

**Non-Goals:**

- Phase 2 visual redesign.
- Any model-backed editing, inpainting, masking, outpainting, or continuation.
- Studio reference-image generation or Studio direct regeneration.
- Automatic billable probing, provider retry, transport replay, or real generation during development.
- Automatic dependency installation, current-plugin replacement, release, deployment, or real-data cleanup.
- Closing the external Windows/Ubuntu Task 9.1 evidence gap.

## Decisions

### 1. Make generation-only schemas the source of truth

`packages/contracts` will first replace the edit-aware unions with strict generation-only schemas. Public operations remain seven by replacing `routego_edit` with `routego_prepare_regeneration`. `routego_batch` omits a caller concurrency field and accepts only generation tasks. Main-conversation generation allows zero through five reference locators; Studio generation allows none.

Strict Zod objects reject stale edit, mask, continuation, and concurrency fields. Downstream code is changed only after contract tests compile, so TypeScript identifies all remaining edit branches instead of leaving unreachable compatibility shims.

Alternative considered: keep deprecated edit fields but ignore them. Rejected because that creates false compatibility, ambiguous billing behavior, and dead code.

### 2. Remove editing vertically, not only from Studio

Removal proceeds through contracts, Creation provider/request/executor paths, Integration routes and graph composition, MCP registration, Library relationship/actions, Studio routes/components/uploads, tests, exports, and docs. Source files solely owned by masking/editing are deleted after imports and tests are migrated. Shared helpers that still serve generation remain.

The provider capability ledger remains internally available for routing and status, but CapabilityLedger/CapabilityHint presentation is deleted. Server-side validation continues to reject unsupported reference generation.

Alternative considered: hide edit controls and retain backend editing. Rejected because the user explicitly removed the capability and hidden public surfaces would remain risky and costly to maintain.

### 3. Snapshot provider, model, and global controls at submission

Integration resolves active provider/model exactly once per single request or batch submission. A batch captures provider, model, global format, and global transparency before workers start; every item receives that immutable snapshot. Active provider changes update Settings atomically for future resolutions only.

Provider switch behavior is:

1. validate the target configured profile;
2. choose the current model if present in the target's cached catalog;
3. otherwise choose the target's valid configured/default model;
4. atomically persist profile and model together;
5. update Header state only from the validated response.

Alternative considered: workers read active settings when each item starts. Rejected because one submitted batch could unexpectedly span providers.

### 4. Keep Studio state small and deterministic

The workbench draft contains only prompt, size, aspect ratio, format, count, and transparency. Reducer-level transitions enforce size/aspect and transparency/format interactions before request construction. Settings defaults are projected into a new draft, including hidden defaults at the service layer, but removed workbench controls cannot be serialized by the browser.

Batch items contain prompt, size, aspect ratio, and count. The batch request builder injects submission-time format/transparency and the runtime always starts two workers. The UI removes reorder and concurrency controls while retaining add/remove, validation, cancellation, item state, and honest aggregate results.

Alternative considered: preserve the current broad draft and hide fields with CSS. Rejected because stale values could still be submitted invisibly.

### 5. Version Library data and separate preflight from execution

The Library index will move to a new schema version that can represent one optional `currentMarkRecordId` and generation-only active records. Upgrade is not an automatic destructive parse side effect.

The migration has explicit phases:

1. Parse the legacy index read-only and build a reverse dependency graph.
2. Classify legacy Trash generation records, edit records, files, shared blobs, conflicts, and surviving references.
3. Return a redacted preflight report and deterministic fingerprint.
4. Require a separately supplied exact confirmation for real data.
5. Under the Library lock, recheck the fingerprint, journal intent, and copy affected index/bytes to a recovery area.
6. Stage the new index and file removals, atomically promote the index, verify surviving locators and reference counts, then finalize cleanup.
7. On any failure, replay the journal and restore the prior consistent state.

Any generation-to-edit dependency aborts the entire migration before mutation and returns record IDs, not paths. Development tests use synthetic temporary directories only. The shipped migration cannot infer consent from application startup, plugin installation, or a previous unrelated confirmation.

Alternative considered: delete legacy entries while parsing schema v1. Rejected because parsing would become destructive and dependency conflicts could leave partial state.

### 6. Represent regeneration as safe data preparation

The current mark is a single stable generation record ID in the Library index. Mark/unmark is an atomic Library mutation and never calls Creation. Copy generation information uses a browser-safe projection.

`routego_prepare_regeneration` resolves either an explicit record ID or the current mark, verifies that the record and all zero-to-five references remain eligible, and returns a generation recipe using stable IDs. Public projection excludes absolute paths, URLs not explicitly allowed by contract, credentials, bytes, and provider headers. The operation remains read-only and records zero provider requests.

Alternative considered: create a Studio “generate again” button. Rejected because generation must occur in the main conversation and requires a new explicit user action.

### 7. Route transparency through one provider attempt and optional local inference

Provider routing uses scoped four-state evidence:

- `supported`: request native transparent PNG, decode it, and accept it only when alpha inspection passes;
- `unknown` or `unsupported`: request ordinary PNG once and mark it for local processing;
- native result fully opaque: send the already-returned PNG to local processing;
- provider or local failure: preserve any valid original and report the transparent rendition failure without replay.

U-2-Netp runs with ONNX Runtime Web's WASM backend inside a Node worker. A process-wide queue permits one inference worker. The worker receives bounded decoded pixel data, resizes/normalizes for inference, restores the mask to source dimensions, composites alpha, returns a validated derived PNG, and is terminated in `finally` after success, error, timeout, or cancellation.

Quality gates reject invalid dimensions, non-finite mask values, effectively empty/full masks, anomalous boundary/coverage results, and corrupt re-encoded alpha. Limits cover input bytes, decoded pixels, inference deadline, and derived output bytes. Failed derived files are removed; originals are never replaced.

Model, WASM, licenses, versions, and SHA-256 values are recorded in a package resource manifest. Runtime never downloads assets. Exact artifact hashes will be frozen only after dependency acquisition is authorized and inspected.

Alternative considered: native Node ONNX runtime. Rejected because native binaries increase platform packaging risk. Alternative considered: no local transparency fallback. Rejected because the user accepted the small local model when resource bounded.

### 8. Eliminate automatic provider retry

Creation submits each planned provider generation attempt once. Timeout, 429, 5xx, disconnect, possible billing, and malformed output all terminate that operation with structured retry disposition and request count. A user can submit a new independent operation, but no code path replays or changes transport automatically.

Alternative considered: retain existing pre-generation 429/5xx retries. Rejected because the user requires no automatic real-generation retry and upstream billing state may be unknowable.

### 9. Verify packaging and B-01 without changing the current installation

After implementation and authorized dependency integration, build a temporary plugin artifact, run repository safety and package-manifest verification, install it into an isolated temporary `CODEX_HOME`, and run offline smoke tests. The smoke must open the same launch URL twice inside the 60-second window to prove the package contains B-01, and must verify packaged model/WASM integrity without network access.

The real installed plugin, marketplace, HOME, and user Library remain untouched until a separate deployment approval.

## Ownership And Dependency Boundaries

This change is applied on `codex/routego-integration-g8` by one OpenSpec apply owner. File-area order prevents cross-package contract drift:

- Contracts: `packages/contracts/**`.
- Provider/execution: `packages/foundation/**`, `packages/creation/**`.
- Library and migration: `packages/library/**`.
- Composition/runtime/image processing: `packages/integration/**`.
- Studio: `packages/studio/**` and scoped Playwright tests.
- Packaging/docs: plugin manifest/build/verify scripts and product/development documentation.

Frozen dependencies are Node.js 20.19+, pnpm 11.9+, strict TypeScript, the existing atomic JSON/lock/journal primitives, loopback session security, and browser path-free contracts. A task that needs to change these boundaries must first update this OpenSpec design.

## Error And Security Boundaries

- Contract validation occurs before file resolution, provider selection, or network access.
- Browser and MCP results use stable IDs and redacted messages; internal paths stay inside Library/Integration.
- Provider/model/profile snapshots never include credentials in logs, results, or Library metadata.
- Clipboard and regeneration projections use explicit allowlists.
- Migration reports contain stable IDs and counts, not paths or image contents.
- Local worker messages contain bounded pixel buffers and metadata only; no credentials or provider configuration.
- Partial batch and transparency outcomes preserve provider request counts and possible-billing flags.

## Verification Strategy

- Contract tests: strict rejection of removed fields/tools, five-reference bound, fixed batch semantics, path/secret redaction.
- Creation/Foundation tests: generation-only routing, reference capability states, no retry on every provider failure class, immutable provider snapshot.
- Library tests: mark replacement/cancel/persistence, safe recipe projection, migration conflicts, shared files, rollback after injected failures, legacy mutation rejection.
- Integration tests: seven-tool registration, removed routes, provider switching, main-conversation references, Studio generation, batch concurrency two, transparent routing, opaque-native fallback, worker lifecycle.
- Studio tests: control interactions, removed markup/routes, Header switching, batch snapshots, Library action scope, clipboard/mark states, loading/empty/success/failure/partial/cancel states.
- Local processing tests: deterministic synthetic PNG/mask fixtures, bounds, alpha/edge gates, timeout/crash cleanup; no user images.
- Full gates: typecheck, package tests, browser tests across desktop/mobile viewports, safety scan, package verification, and isolated offline install smoke.

## Risks / Trade-offs

- [Breaking removal affects stale clients] -> Strict unknown-operation/field failures, release notes, and no compatibility path that could submit editing.
- [Destructive migration could remove referenced files] -> Complete reverse dependency preflight, fingerprinted confirmation, lock, journal, backup, atomic promotion, and fail-before-mutation conflicts.
- [WASM inference increases package size and CPU/memory use] -> Small U-2-Netp model, worker isolation, concurrency one, bounded pixels/time, immediate worker release, and package-size verification.
- [Segmentation quality varies by image] -> Conservative quality gates, preserve original, expose failure, never claim false transparency.
- [Provider switch races with active work] -> Immutable submission snapshots and atomic profile/model activation.
- [Removal spans many packages] -> Contract-first task order, focused tests per layer, dead-code/export scan, then full regression.
- [Existing OpenSpec Task 9.1 remains incomplete] -> Keep it independent and explicitly report 28/29 plus the external Windows/Ubuntu evidence gap.

## Migration Plan

1. Land and validate this proposal, design, delta specs, and tasks as a planning checkpoint.
2. Implement generation-only contracts and update compile-time consumers.
3. Implement runtime/provider snapshot and no-retry behavior; remove edit registration and execution.
4. Implement Library v2 mark, safe preparation, and fixture-only migration with rollback tests.
5. Simplify Studio workbench, Header, Library, and remove mask/edit code.
6. At the dependency gate, request explicit approval before adding U-2-Netp/ONNX Runtime assets; then implement and verify local transparency.
7. Run full offline verification and build an isolated artifact; do not touch the installed plugin.
8. Present the real-data migration preflight design/results and obtain separate explicit approval before any user Library migration.
9. Obtain separate deployment approval before installing or replacing the current plugin.

Rollback for code uses a normal Git revert of this change's commits. Isolated test data is disposable. Real migration rollback uses its journal/recovery copy and must be verified before deployment approval.

## Open Questions

No unresolved product decisions block planning. Two execution gates remain intentionally open:

- exact model/WASM versions, hashes, and package size are finalized only after the user authorizes dependency acquisition;
- real Library migration and current-plugin replacement each require their own later explicit approval.
