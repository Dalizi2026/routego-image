# PD-005：Integration durable source renditions and Studio SSE consumption gap

- Status: accepted for Integration planning; apply remains prohibited
- Change: `integrate-routego-image-plugin`
- Reported by: Integration generation 0 before design/spec/task freeze
- Reviewed by: Program Controller generation 3
- Public MCP impact: none; the seven frozen tool names and public operation registry remain unchanged

## Findings

### 1. Durable uploaded inputs cannot be represented honestly

The frozen Library relationship schema requires every relationship to reference an existing `relatedAssetId`, and an optional `artifactId` must belong to that asset. The current Library ingestion model accepts only operation assets whose renditions are `partial | final`, whose metadata describes a generate/edit execution, and whose output MIME matches the effective output format.

Studio uploads for target, reference, supporting, and mask inputs are not independent generated assets. Creating synthetic generate/edit assets for them would fabricate prompt/model/execution facts. Omitting them would violate durable relationship, detail, comparison, and retry requirements. Pointing their relationships at the final output artifact would also be false.

The reported source-rendition direction is valid, but the minimum complete correction is broader than the initial recommendation:

- add a Library-only rendition phase `source`; do not add `source` to the public `ImageArtifact` phase schema;
- allow one preallocated logical operation asset to own exact source renditions plus partial/final output renditions;
- keep the primary rendition output-only and require succeeded assets to retain a final output;
- allow source MIME types to differ from the effective output format while continuing to enforce the output MIME rule for partial/final renditions;
- raise the bounded Library rendition capacity to 33, derived from at most 16 target/reference/supporting images, one optional mask, four final outputs, and twelve partial outputs;
- preserve source renditions and their checksums through ZIP export/import, with corresponding bounded manifest limits;
- store each relationship against the preallocated operation asset and the exact source/output artifact ID;
- reconstruct Library retry inputs from ordered relationship artifact IDs. If a required exact source relationship is missing or inconsistent, Studio must fail closed instead of falling back to the asset's primary output.

### 2. Studio cannot consume the frozen SSE events

Creation already supplies validated event schemas, an event broker/serializer, and an Integration extension hook, but the Studio gateway exposes only final JSON invocation, binary upload, and protected-resource fetching. The workbench therefore cannot consume `started`, `partial`, `completed`, and `failed` events or preserve streamed partial artifacts when the terminal event fails.

The complete correction must include:

- an Integration-owned protected fetch-stream route for generate/edit that validates the frozen input and emits only frozen `StudioImageOperationEvent` values;
- a browser-safe Studio SSE/fetch-stream parser using the in-memory session header, strict content type and UTF-8 framing, schema validation, monotonically increasing sequence checks, terminal-event enforcement, bounded frames, cancellation, and reader cleanup;
- a minimal workbench streaming state that renders partial artifacts as they arrive, promotes a completed result, and preserves partial artifacts plus billing/output risk after failure;
- deterministic mock-handler and Vite bridge streaming support rather than a buffered fake response;
- focused unit/bridge tests and a browser journey for started/partial/completed/failed order, abort cleanup, invalid sequence/output closure, and secret/path/Base64 exclusion.

## Decision

Authorize these two corrections as prerequisite task groups inside `integrate-routego-image-plugin`; do not create a second concurrent top-level change. This is appropriate because Integration is now the sole active apply owner, Integration owns shared-schema corrections at the final composition phase, and there is no remaining Library or Studio apply owner to race. The Integration OpenSpec must nevertheless treat the corrections as explicit gates that complete before service composition and packaging.

The proposal must be revised before design/spec/tasks continue. It may no longer claim that all 18 main capabilities are unmodified or that all Library/Studio product files are read-only. Delta specs must explicitly modify the affected capabilities, and tasks must enumerate exact allowed files and verification.

Authorized planning areas:

- `shared-image-contracts`: Library-only source rendition phase and bounded detail contract; public image artifact phases remain unchanged.
- `durable-image-library`: source/output co-ingestion, exact relationship ownership, mixed source MIME, output-only primary, and 33-rendition bound.
- `library-portability`: source-rendition ZIP round-trip and adjusted bounded manifest evidence.
- `studio-library-experience`: exact artifact-based retry reconstruction and fail-closed inconsistent relationship handling.
- `studio-creation-workbench`: authenticated streaming consumption, partial/final/failure presentation, and cancellation cleanup.
- Integration's new service/runtime/verification capabilities for composition and the protected stream route.

Potential implementation files are limited to the exact contract, Library, Studio, Integration, focused-test, and browser-test files justified by the approved tasks. At minimum the plan must consider `packages/contracts/src/library.ts`, Library gallery model/ingestion/read and portability boundaries, Studio Library handoff, Studio API/creation streaming state, deterministic Studio mock bridge, and the focused tests for those seams. Tasks must narrow this to exact files before apply.

## Required verification

- `openspec validate --all --strict --no-interactive` with explicit modified-capability delta specs.
- Exact seven public MCP tools and public `ImageArtifact` phase freeze.
- Contract tests proving `source` is accepted only for Library renditions and the 33-item bound is enforced.
- Library tests for mixed-format source/output ingestion, output-only primary selection, exact relationship artifact ownership, corruption rejection, search/detail/resources, and no legacy/path leakage.
- ZIP export/import tests preserving source phases, relationships, IDs, checksums, Unicode, limits, and collision remapping.
- Studio retry tests proving target/reference/supporting/mask locators use exact relationship artifact IDs and fail closed on ambiguity.
- Studio SSE parser/gateway/workbench/mock/browser tests for authentication, started/partial/completed/failed order, monotonic validation, failure-after-partial preservation, abort cleanup, and no token/key/path/Base64 leakage.
- Full safety, typecheck, build, tests, package exports, browser suite, diff scope, and Git cleanliness.

## Gates and prohibitions

- This decision authorizes proposal/design/delta-spec/task continuation only after the Controller sends a structured proposal-only activation message.
- It does not authorize apply, product edits, task checkboxes, real credentials, real user images, real Library data, real relay calls, billable probes, installation replacement, deployment, publication, marketplace replacement, or release.
- Integration must return `[INTEGRATION_PLAN_READY]` with a complete commit and strict validation. Controller approval of that plan is still required before apply.

