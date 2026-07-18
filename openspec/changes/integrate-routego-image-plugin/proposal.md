## Why

Creation, Library, and Studio are independently implemented and archived, but Routego Image is not yet a usable Codex plugin: there is no production `LocalRoutegoService` composition, plugin entrypoint, self-contained package, clean-install smoke test, cross-platform release gate, or approved real-relay acceptance path. This final change joins the frozen lanes without changing their product rules or the seven public MCP tools, then establishes the evidence and rollback controls required for a safe 1.0.0 release.

## What Changes

- Add the production Integration layer that reads the active redacted/provider configuration through Library ownership, supplies in-memory credentials and frozen capability evidence to Creation, resolves Studio asset/artifact/upload locators through Library, executes resolved image jobs through Creation, persists successful and partial artifacts, and projects browser-safe results and resources through one `LocalRoutegoService`.
- Correct the frozen deterministic mock baseline before Integration package verification: mock Library detail will identify its already-existing output rendition as `primaryArtifactId`, with a focused schema-valid regression. This repair changes no product behavior, public MCP tool, or public `ImageArtifact.phase`.
- Add the PD-005 prerequisite Library correction before composition: a Library-only `source` rendition phase, a maximum of 33 source/partial/final renditions on one preallocated operation asset, output-only primary selection, mixed source MIME support, exact relationship artifact ownership, ZIP round-trip/limits, and fail-closed Studio retry reconstruction from ordered relationship artifact IDs. Public `ImageArtifact.phase` remains exactly `partial | final`.
- Add the PD-005 prerequisite Studio correction before composition: the authenticated `POST /api/v1/studio/creation/stream` route plus a browser-safe Studio SSE parser/gateway/workbench flow that requires exactly one first `started` event, zero or more `partial` events, exactly one `completed | failed` terminal event, one request ID, strict monotonic sequence, terminal-before-EOF, bounded schema-valid framing, deterministic mock streaming, and honest failure-after-partial billing/output presentation.
- Separate stream/channel cleanup from protected partial-resource lifetime: terminal, disconnect, cancel, or unmount closes readers and event channels but does not shorten the descriptor expiry fixed at registration as the earlier of five minutes later or the owning session expiry. Studio revokes only its browser object URLs during UI cleanup; the server descriptor remains until that bounded expiry or immediate process shutdown.
- Complete Integration-owned image-output handling, including non-overwriting project copies and explicitly reported simple chromakey transparency post-processing, without claiming native transparency or complex-background support when the configured relay has not proven it. Chromakey keeps provider-original bytes only in the request transaction, persists/projects at most one output artifact per slot under the existing output identity, and adds no rendition or relationship role beyond the fixed 33-item graph.
- Wire the long-running STDIO MCP runtime to exactly `routego_status`, `routego_generate`, `routego_edit`, `routego_batch`, `routego_search_library`, `routego_manage_library`, and `routego_open_studio`; add the Routego Image Skill that invokes those tools and returns validated paths/image content without exposing secrets or intermediate-image floods.
- Add loopback Studio startup and reuse, short-lived in-memory session tokens, exact loopback origin checks, protected upload/resource byte routes, validated JSON/SSE dispatch, Studio static-asset serving, lifecycle cleanup, and safe `routego_open_studio` URLs.
- Add the `routego-image` 1.0.0 plugin manifest, runtime launchers, bundled Studio assets, third-party notices, build/staging scripts, and a self-contained artifact whose target runtime requires Node.js 20.19+ but no target-machine workspace install or native compilation.
- Add isolated temporary-`CODEX_HOME` installation and fresh-task smoke tests for the Skill, all seven MCP tools, Studio launch, shared Library visibility, package contents, secret/data exclusion, and rollback-safe coexistence with the legacy plugin/configuration/Library.
- Add Windows, Ubuntu, and macOS CI on Node.js 20.19+ for frozen install, safety, strict OpenSpec, typecheck, build, all unit/browser/integration tests, package exports, self-contained packaging, and smoke verification.
- Define a separate real-relay acceptance gate for text generation, two references, direct edit, mask edit, partial batch, and transparency, including Codex/Studio shared-Library verification. It remains blocked until the user explicitly approves credentials, possible charges, synthetic acceptance inputs, and each billable request class.
- Define release and rollback governance using temporary staging, cachebuster/reinstall tooling, atomic plugin-directory replacement, post-install verification in a fresh Codex task, preservation/archival of the legacy plugin and data, and automatic restoration on failed acceptance. No deployment, publication, marketplace replacement, or billable probe occurs merely by applying this change.

### Non-goals

- No addition or renaming of public MCP tools, rendition/relationship role invented for chromakey, or main-spec, Library, or Studio change beyond the five PD-005 modified capabilities, their exact prerequisite implementation/test seams, and the narrow deterministic mock baseline repair. Creation provider/executor internals remain read-only.
- No inferred `/images/edits`, `/responses`, `/models`, or other sibling endpoint; unverified capabilities stay unavailable, and transient failures do not become permanent unsupported evidence.
- No real API key, authorization header, user image, real Library data, or legacy data enters the repository, fixtures, ordinary logs, or planning artifacts.
- No destructive migration or deletion of the existing plugin, old configuration, or old image Library.
- No real-relay request, capability probe, installation replacement, deployment, publication, or paid operation without the explicit approval gate defined by this change.

## Capabilities

### New Capabilities

- `integrated-local-routego-service`: Production composition of Library-owned configuration/resources and Creation-owned execution into one public and path-free local service, including artifact persistence, browser projection, output copying, and honest transparency handling.
- `codex-plugin-runtime`: The exact seven-tool MCP server, Routego Image Skill, loopback HTTP/session/origin/upload/resource/SSE runtime, Studio static serving, launch reuse, shutdown, and redacted diagnostics.
- `plugin-packaging-installation`: The 1.0.0 plugin manifest, launchers, bundled assets/notices, reproducible self-contained artifact, temporary-`CODEX_HOME` install, and fresh Codex task smoke verification.
- `cross-platform-integration-verification`: Windows/Ubuntu/macOS Node.js 20.19+ CI and offline end-to-end gates spanning service composition, MCP, HTTP, Studio, Library, packaging, security, and deterministic acceptance fixtures.
- `real-relay-acceptance`: Explicitly approved, cost-aware real-relay verification for the required generation/edit/reference/mask/batch/transparency matrix and shared Codex/Studio Library results.
- `plugin-release-and-rollback`: Approval-gated cachebuster/reinstall, staged atomic replacement, fresh-task post-install acceptance, legacy preservation, rollback, and release evidence.

### Modified Capabilities

- `shared-image-contracts`: Add a Library-only source rendition phase and bounded source/output detail contract while preserving the public image artifact phase and seven-tool surface.
- `durable-image-library`: Co-ingest exact source plus partial/final output renditions on one preallocated operation asset, enforce output-only primary/final invariants, mixed source MIME, the 33-rendition limit, and exact relationship artifact ownership.
- `library-portability`: Preserve source renditions, phases, relationships, identifiers, checksums, Unicode, collision remapping, and adjusted bounded manifest limits through ZIP export/import.
- `studio-library-experience`: Reconstruct retry/edit target, references, supporting images, and mask from ordered exact relationship artifact IDs and fail closed on missing, ambiguous, or inconsistent relationships.
- `studio-creation-workbench`: Consume the exact authenticated stream route with a first/unique `started` state machine, render arriving partials, promote terminal success, preserve failure-after-partial billing/output risk and session-capped resource lifetime of up to five minutes, and clean up channels/browser object URLs without premature server-resource revocation.

## Impact

- Expected product scope: the exact PD-005 contract/Library/Studio prerequisite files and focused tests, the deterministic mock Library-detail baseline and its focused service test, a new Integration-owned runtime/package area, plugin manifest and Skill files, packaging/install/release scripts, integration tests, CI workflow, and only the root dependency/workspace/lockfile changes justified by the approved design.
- Authorized cross-lane impact is limited to the PD-005 Library rendition/ingestion/read/ZIP seams, Studio Library retry seam, the deterministic mock Library-detail fixture, Studio API/creation streaming state, deterministic mock bridge, and focused/browser tests enumerated in `tasks.md`. The mock correction only binds `primaryArtifactId` to its existing output rendition. All other Creation, Library, Studio, shared, Foundation, and main-spec files remain read-only without a new `[PLAN_DEVIATION]`.
- Public interface impact: the plugin name remains `routego-image`, the release version is `1.0.0`, and the MCP surface remains exactly the seven frozen tool names. Studio-only operations remain internal loopback operations.
- Runtime impact: the shipped package is loopback-only, stores new data only under the approved Routego Image 1.0 roots, preserves all legacy files, and requires Node.js 20.19 or newer.
- External-state impact: real credentials, billable relay calls, marketplace replacement, deployment/publication, and final installation replacement are approval-gated acceptance/release tasks, not automatic apply actions.
