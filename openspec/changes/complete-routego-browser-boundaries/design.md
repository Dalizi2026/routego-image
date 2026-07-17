## Context

The archived Foundation and Foundation Extension changes froze seven public MCP operations, path-based server/Codex image contracts, browser-safe settings reads, Library detail/resources, and one composed `LocalRoutegoService`. PD-004 found that Studio still cannot complete an approved browser journey: browser bytes have no protected upload lifecycle, Studio creation still depends on local paths, public Library search returns `path`, defaults/output-directory settings cannot be mutated, and the deterministic mock gallery is empty.

This corrective gate is the only apply-owner for the missing shared boundary. It owns only `packages/contracts/**`, `packages/mock-relay/**`, focused tests, and `openspec/changes/complete-routego-browser-boundaries/**`. Creation, Library, and Studio are read-only. Root dependencies, lockfiles, workspace configuration, real transport/persistence, plugin packaging, installation, release, and user data are forbidden.

Frozen dependencies:

- `routegoOperationNames`, `routegoOperationDefinitions`, `RoutegoService`, the seven MCP tool names, and all existing public path-based MCP contracts remain unchanged.
- Existing provider tiers and four-state capability evidence remain unchanged; this change performs no provider routing or billable request.
- Existing `BrowserResourceDescriptor` remains the path-free protected byte-delivery descriptor and is generalized only enough to serve Studio creation artifacts as well as Library assets.
- Creation executes only resolved internal `ImageOperationRequest` values. Library/upload storage resolves browser identifiers to internal resources. Integration composes those responsibilities and owns real HTTP/session/origin/binary streaming.

## Goals / Non-Goals

**Goals:**

- Freeze a complete session upload resource lifecycle with purpose, policy metadata, integrity metadata, status, reuse/consumption rules, and structured errors.
- Freeze path-free Studio generate/edit/batch inputs, results, relationships, errors, and SSE events that cover all approved image controls and preserve billing/output flags.
- Freeze a path-free Studio Library search that reuses public filter/cursor semantics and aligns identifiers with detail, relationship, and resource operations.
- Freeze defaults and output-directory mutation semantics with an explicit safe local-path strategy.
- Provide a stateful deterministic mock with non-empty aligned gallery data, stable filtering/pagination, upload lifecycle outcomes, path-free creation outcomes, and settings updates reflected by subsequent reads.
- Prove public-operation freeze, browser safety, deterministic behavior, strict validation, and clean delivery without product implementation.

**Non-Goals:**

- Real upload byte storage, MIME sniffing, checksum calculation, dimension decoding, expiry scheduling, durable resource ownership, ZIP parsing, filesystem reads/writes, or local path selection UI.
- Provider adapters, task execution, network calls, retries, HTTP routing, session-token generation, origin enforcement, SSE transport, Studio components, browser journeys, or plugin release work.
- New public MCP tools, renamed public operations, arbitrary external image URLs, provider credentials, or bytes/Base64 in Studio JSON.
- Any new third-party dependency, native addon, root manifest change, or lockfile change.

## Decisions

### 1. Keep public MCP contracts path-based and add Studio-only path-free schemas

The public `ImageOperationRequest`, result schemas, Library search result, seven operation definitions, and `RoutegoService` remain untouched because Codex/server callers legitimately use local paths and display data. New browser contracts live in dedicated browser-safe modules and are registered only in `studioOperationNames`/`studioOperationDefinitions`.

`LocalRoutegoService` is extended through new `StudioUploadService`, `StudioCreationService`, and the existing Studio Library/settings subinterfaces. MCP can continue depending on `RoutegoService`; loopback HTTP can depend on the composed local service. Appending the new methods to the public registry was rejected because it would violate the seven-tool freeze. Replacing public path-based schemas was rejected because it would break Codex/server workflows.

### 2. Model uploads as JSON control-plane state plus a protected binary data-plane route

`upload.ts` defines:

- purposes `image | reference | target | supporting | mask | zip-import`;
- a reservation input containing purpose, declared MIME, declared byte length, and optional expected SHA-256, but no file path, bytes, Base64, credential, or arbitrary URL;
- a protected relative `PUT` route descriptor with `requiresSession=true`, `requiresOrigin=true`, allowed MIME values, maximum bytes, and expiry;
- lifecycle states `reserved | uploaded | finalized | consumed | discarded | expired | failed`;
- final metadata containing detected MIME, byte length, SHA-256, optional image dimensions, status, and timestamps;
- reserve, finalize, status, and discard operations.

Image-like resources are reusable by Studio creation operations until expiry or discard. ZIP-import resources are single-consume: successful import transitions them to `consumed`, and later use returns `upload_consumed`. Mask policy permits only PNG at this boundary; other image purposes permit PNG/JPEG/WebP. Exact maximum byte policies are returned by the service rather than frozen globally in the schema; the future Library implementation enforces the returned policy and the existing mask limit.

The binary route itself is not a JSON service method. Integration later streams it under session/origin/size/MIME enforcement, while Library owns staging, contained storage, sniffing, checksum, dimensions, expiry, and disposal. A JSON Base64 upload alternative was rejected because it leaks large sensitive data into parsers, logs, and diagnostics.

### 3. Use explicit stable locators for Studio image inputs

`StudioImageInputRef` is a strict discriminated union containing exactly one locator:

- `source=asset` with `assetId`;
- `source=artifact` with `artifactId`;
- `source=upload` with `uploadResourceId`.

References and supporting images remain ordered and carry approved roles/labels. Edit has exactly one target. A mask carries `targetSlot: 0` as a literal so the target mapping is unambiguous. Generate rejects target/supporting/mask/invariant fields; edit requires target and invariants. Total physical image inputs remain at most 16.

Studio operation parameters mirror the existing prompt, count, partial image, size/aspect ratio, quality, format, compression, transparency, moderation, action, continuation IDs, invariants, and library-save semantics, but omit local `outputDir`, `path`, data URL, and provider credential fields. Output-directory choice is resolved from settings by the future service.

### 4. Define a separate path-free result and error projection

Studio results cannot reuse `ImageArtifact` or `RoutegoServiceError` directly because those public schemas may contain local paths, image data URLs, or public partial artifacts. The contracts factor common error metadata and define a Studio error projection whose partial artifacts are path-free.

Each Studio artifact contains `artifactId`, optional `assetId`, slot/phase, MIME/integrity/dimension metadata, and a required `BrowserResourceDescriptor`. Relationships identify input locator/role/order/target slot and output artifact IDs without paths. Requested and effective parameters both use Studio schemas. Execution retains transport, attempt/provider request counts, `receivedAnyOutput`, `mayHaveBilled`, degraded continuation, and provider IDs.

Final operation status is `succeeded | partial | failed`. SSE schemas cover `started`, `partial`, `completed`, and `failed` with monotonic sequence metadata. Partial and failed events preserve `receivedAnyOutput` and `mayHaveBilled`; no event permits bytes, Base64, local paths, arbitrary external URLs, or credentials.

### 5. Preserve ordered batch semantics

Studio batch accepts 1-20 unique task IDs and concurrency 1-10. Each task contains a Studio generate or edit request. Results preserve the exact input order and return one result per task. Overall status is derived as `succeeded`, `partial`, or `failed`; partial includes mixed successes/failures or any partial item. This mirrors the public batch limits while keeping every nested DTO path-free.

### 6. Reuse public search filters with a distinct Studio result

`searchStudioLibrary` uses `routegoSearchLibraryInputSchema` directly so query, model, date, kind, size, status, folder, deleted-state, sort, limit, and cursor semantics cannot drift. Its result contains `assetId`, primary `artifactId`, prompt/model/kind/format/dimensions/status, folder IDs, timestamps, and an optional protected thumbnail descriptor. It never returns `path`/`filePath`.

The same asset/artifact IDs must resolve through detail, relationships, browser resources, retry/edit handoff, and creation input locators. Replacing the public search result was rejected because the path-based MCP result remains required.

### 7. Mutate settings through one strict operation and explicit local-path confirmation

`updateSettings` accepts an optional complete `defaults` value plus an output-directory mutation. At least one mutation must be present. Output-directory operations are:

- `unchanged`: preserve the stored selection;
- `default`: select the application-managed default output directory;
- `clear`: remove the configured output directory so no explicit output directory is selected;
- `replace`: carry a local path plus `confirmLocalPath: true`.

The `replace` input is the one deliberate browser-to-server local configuration path boundary. It is allowed only for this user-confirmed settings action, not for image inputs/search/resources. The future Library/settings implementation must canonicalize the path server-side, require an absolute local non-root destination, reject NUL/traversal/legacy protected roots/unsafe symlink resolution and non-local or credential-bearing forms, and verify that the destination is user-owned/creatable before persistence. Results return only the existing redacted `configured`/`display` state and never echo the submitted full path.

A server-issued selection token was considered. It would be safer for an OS picker but requires a real picker/session token workflow outside this contracts-only gate. Explicit confirmation plus strict future server validation preserves the approved settings behavior without inventing UI or transport implementation.

### 8. Make the mock stateful, deterministic, and self-contained

`MockRoutegoService` keeps only in-memory synthetic state seeded from constants and deterministic hashes. It never reads the filesystem, environment, user configuration, network, credentials, or user images.

The gallery seed contains at least:

- a succeeded generate asset;
- a partial edit asset with target/reference/supporting/mask/output relationships;
- a deleted generate asset;
- multiple active/deleted folders and stable timestamps.

Search implements every public filter, stable sorting, opaque deterministic cursor pagination, and optional thumbnails. Detail, relationships, resources, retry/edit handoff IDs, and search rows share the same seed records.

Upload reservations keep synthetic lifecycle state. Finalize returns fixed synthetic integrity metadata for success, and fixture controls expose expired, not-found, invalid-type, oversize, checksum-failed, consumed, and discard outcomes without receiving bytes. ZIP import execution consumes a finalized ZIP resource once. Image resources remain reusable. Settings/profile/default/output-directory mutations update in-memory state so later `readSettings` calls reflect them. Studio generate/edit/batch fixtures produce path-free success, partial, failure, and degraded results.

### 9. Structured errors are explicit and fail closed

Upload/resource-specific codes for expiry, invalid MIME, oversize, checksum mismatch, consumed, and discarded state live in an upload-local error schema used only by Studio/local upload operations; ordinary missing resources use `not_found`. The frozen public `routegoErrorCodeSchema` and public MCP result schemas remain unchanged. Studio output parsers reject any unknown field or invalid status/artifact/error combination. Success never carries an error, failed always carries one, partial must contain output or failed slots, and automatic retry metadata remains forbidden after output/billing risk.

### 10. Verification and ownership gates

Focused contract tests cover every lifecycle/status/error, strict path/URL/byte/credential rejection, mask slot zero, limits/invariants/controls, SSE flags, ordered batch status, search filters/cursors/ID alignment, settings semantics, and the frozen public registry. Mock tests cover non-empty deterministic gallery data, repeatability, upload reuse/consume/discard/expiry/failure, path-free creation outcomes, and stateful settings.

Final verification runs strict OpenSpec, repository safety, typecheck, build, all tests, seven package export checks, browser-safe source/declaration/emitted-output audits, public-operation freeze, deterministic repeat runs, diff scope, and Git cleanliness. No task may be checked before its implementation commit and listed verification pass.

## Risks / Trade-offs

- [Risk] A Studio DTO accidentally reuses a public path/data-URL artifact. → Mitigation: separate schemas, strict unknown-field parsing, forbidden-field tests, and source/declaration/emitted audits.
- [Risk] Upload policy metadata could be mistaken for enforcement. → Mitigation: specs assign real enforcement to Library/Integration and tests label the mock synthetic; this gate provides contracts only.
- [Risk] Explicit local-path settings input could expose sensitive paths. → Mitigation: literal confirmation, server-side canonical validation requirements, and results that never echo the full value.
- [Risk] Stateful mocks could become order-dependent. → Mitigation: each service instance starts from an immutable seed, IDs/cursors use canonical deterministic hashing, and tests create isolated instances where state matters.
- [Risk] Search/detail/resource fixtures drift apart. → Mitigation: generate all projections from one seeded asset graph and add cross-operation ID assertions.
- [Risk] Extending internal operation registries could leak into MCP. → Mitigation: preserve separate registries and byte-for-byte semantic freeze tests for all seven public definitions/methods.

## Migration Plan

1. Strictly validate proposal, design, delta specs, and tasks before implementation.
2. Implement and commit upload/error contracts with focused tests.
3. Implement and commit path-free Studio creation/batch/SSE contracts and service registration.
4. Implement and commit path-free search and settings mutation contracts.
5. Implement and commit the deterministic stateful mock and its full scenario matrix.
6. Run the complete final gate, record immutable SHAs, update task state only after commits, and send `[BROWSER_BOUNDARY_COMPLETE]` to the Program Controller.
7. The Program Controller merges the branch and wakes Creation, Library, and Studio. Rollback is a normal `git revert`; there is no deployment, persistence, or user-data migration.

## Open Questions

None. PD-004 and the delegation fix the public freeze, ownership, settings input strategy choice, downstream responsibilities, and non-goals. Any requirement for a public MCP addition, dependency/lockfile change, or product implementation is a `[PLAN_DEVIATION]`.
