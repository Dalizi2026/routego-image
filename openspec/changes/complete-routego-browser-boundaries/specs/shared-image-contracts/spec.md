## ADDED Requirements

### Requirement: Session upload reservation and lifecycle contracts
The shared package SHALL define strict browser-safe reserve, finalize, status, and discard schemas for upload purposes `image`, `reference`, `target`, `supporting`, `mask`, and `zip-import`. A reservation result MUST include a stable `uploadResourceId`, a protected relative binary upload route, allowed MIME types, maximum bytes, expiry, session/origin requirements, and an explicit reuse policy without containing bytes, Base64, credentials, or a local filesystem path.

#### Scenario: Browser reserves an image upload
- **WHEN** Studio reserves a reference image using declared MIME, byte length, and optional expected SHA-256
- **THEN** the result SHALL return a reusable upload resource ID and protected relative upload route with the applicable MIME, size, and expiry policy

#### Scenario: Browser reserves a ZIP import
- **WHEN** Studio reserves a `zip-import` resource
- **THEN** the result SHALL allow only ZIP MIME policy and SHALL mark the resource single-consume

#### Scenario: Unsafe reservation data is supplied
- **WHEN** a reservation includes a local path, image bytes, Base64, credential, arbitrary external URL, unknown field, invalid MIME, or byte length outside the declared policy shape
- **THEN** shared validation SHALL reject it before any binary route or storage logic is invoked

### Requirement: Finalized upload metadata and structured lifecycle failures
Finalized upload status SHALL include detected MIME, byte length, SHA-256, optional width/height for images, lifecycle status, creation/finalization/expiry metadata, and reuse policy. Upload operations SHALL represent expired, not-found, invalid-type, oversize, checksum-failed, consumed, discarded, and generic failed outcomes with structured errors rather than false success.

#### Scenario: Image upload finalizes successfully
- **WHEN** the protected binary route has accepted a valid image and finalize verifies its policy
- **THEN** the result SHALL be `finalized` with detected MIME, exact byte length, SHA-256, and image dimensions when available

#### Scenario: Checksum does not match
- **WHEN** the finalized bytes do not match the optional expected SHA-256 from reservation
- **THEN** the result SHALL fail with a structured `upload_checksum_failed` error and SHALL NOT expose or authorize the bytes

#### Scenario: Upload is expired or missing
- **WHEN** finalize/status/discard addresses an expired or unknown upload resource
- **THEN** the result SHALL return `upload_expired` or `not_found` without revealing a staging path

#### Scenario: ZIP upload is reused after import
- **WHEN** a finalized ZIP resource has already been consumed by a successful import
- **THEN** later use SHALL fail with `upload_consumed`, while finalized image resources MAY be reused until expiry or discard

### Requirement: Path-free Studio image input references
Studio image inputs SHALL use a strict `StudioImageInputRef` that contains exactly one stable locator: `assetId`, `artifactId`, or `uploadResourceId`. Studio generation and edit inputs MUST NOT contain local paths, file URLs, unrestricted external URLs, provider credentials, bytes, Base64, or public `ImageArtifact` display data.

#### Scenario: Generate uses ordered upload and Library references
- **WHEN** Studio submits references using a mix of asset, artifact, and finalized upload IDs
- **THEN** the schema SHALL preserve their order, role, and optional label without resolving or exposing a path

#### Scenario: Edit binds mask to target slot zero
- **WHEN** Studio submits one target, supporting inputs, and a mask
- **THEN** the mask SHALL carry literal `targetSlot: 0`, and validation SHALL reject any other or missing target mapping

#### Scenario: Browser supplies a path or external image URL
- **WHEN** any Studio image reference contains `path`, `filePath`, `dataUrl`, an absolute URL, or an unknown locator combination
- **THEN** shared validation SHALL reject the request before service dispatch

### Requirement: Complete path-free Studio creation parameters
Studio generate and edit contracts SHALL cover prompt text, up to 16 ordered physical image inputs, edit invariants, size, aspect ratio, quality, format, compression, count, partial-image preference, transparency, moderation, continuation action and identifiers, and library-save preference. Generate SHALL reject edit-only fields; edit SHALL require exactly one target and non-empty invariants; PNG/compression and transparency/format rules SHALL match the public image contracts.

#### Scenario: Text-only generate uses approved controls
- **WHEN** Studio submits a non-empty text-only generate request with values inside the approved limits
- **THEN** the request SHALL parse without requiring a local output directory or image locator

#### Scenario: Edit input is ambiguous
- **WHEN** Studio edit omits its target/invariants, exceeds 16 physical inputs, uses a mask without target slot zero, or violates format/compression/transparency bounds
- **THEN** the request SHALL be rejected before resource resolution or provider execution

#### Scenario: Continuation remains path-free
- **WHEN** Studio requests continuation using provider response/image/file identifiers or a previous asset/artifact/upload target
- **THEN** the request SHALL preserve the continuation intent without accepting a provider credential or local path

### Requirement: Path-free Studio creation results and SSE events
Studio creation results SHALL contain path-free requested/effective parameters, execution metadata, path-free artifacts, ordered relationships, failed slots, structured path-free errors, and explicit `succeeded | partial | failed` status. Each artifact MUST include `artifactId` and a protected `BrowserResourceDescriptor`, MAY include `assetId`, and MUST NOT contain a local path, arbitrary external URL, provider credential, bytes, Base64, or data URL. Studio SSE event schemas SHALL cover `started`, `partial`, `completed`, and `failed` and preserve `receivedAnyOutput` and `mayHaveBilled` whenever output or failure is reported.

#### Scenario: Studio creation succeeds
- **WHEN** a Studio generate or edit completes with final output
- **THEN** the result SHALL include one or more path-free artifacts and relationships whose output IDs match those artifacts

#### Scenario: Stream fails after partial output
- **WHEN** a Studio stream emits a partial artifact and then fails
- **THEN** partial/failed events and the final result SHALL preserve the artifact, `receivedAnyOutput=true`, `mayHaveBilled=true`, and a non-automatic retry disposition

#### Scenario: Result leaks a public artifact path or data URL
- **WHEN** a Studio artifact/error/event contains a local path, display data URL, Base64, credential, or unrestricted URL
- **THEN** output validation SHALL fail closed as an internal contract error

### Requirement: Ordered path-free Studio batch contracts
Studio batch SHALL accept 1 through 20 unique ordered task IDs with concurrency 1 through 10, SHALL preserve one path-free result for every input task in the same order, and SHALL report overall `succeeded`, `partial`, or `failed` consistently with item outcomes.

#### Scenario: Mixed batch partially succeeds
- **WHEN** ordered Studio tasks produce a success, a partial result, and a failure
- **THEN** the batch result SHALL be `partial`, preserve task order, and include one honest result/error for every task

#### Scenario: Batch bounds or identity are invalid
- **WHEN** Studio exceeds task/concurrency limits, repeats a task ID, or returns missing/reordered item identities
- **THEN** input or output validation SHALL fail before false success is serialized

### Requirement: Path-free Studio Library search contracts
The shared package SHALL define a Studio Library search operation that reuses the complete public `routegoSearchLibrary` filter, sort, limit, and cursor input semantics. Its result SHALL use `assetId` and `artifactId`, metadata, folder IDs, status/deletion state, timestamps, and an optional protected thumbnail descriptor, and SHALL NOT expose `path` or `filePath`.

#### Scenario: Studio searches and paginates the gallery
- **WHEN** Studio applies query/model/date/kind/size/status/folder/deleted filters with a cursor and limit
- **THEN** the service result SHALL preserve those semantics, stable ordering, and a deterministic next cursor without returning a local path

#### Scenario: Search row opens detail or image resource
- **WHEN** Studio selects a search row's asset/artifact identifiers
- **THEN** those identifiers SHALL be valid for asset detail, relationships, browser resource retrieval, retry/edit handoff, and Studio image input references

#### Scenario: Unsafe thumbnail descriptor is returned
- **WHEN** a search result thumbnail contains a file path or absolute external URL
- **THEN** output validation SHALL fail closed

### Requirement: Defaults and output-directory mutation contracts
The shared package SHALL define a Studio settings mutation that updates complete defaults and/or applies exactly one output-directory operation: `unchanged`, `default`, `clear`, or `replace`. `replace` MUST carry `confirmLocalPath: true`; other operations MUST carry no path. Successful results SHALL return the complete redacted settings view with only configured/display output-directory state and MUST NOT echo the submitted full path.

#### Scenario: Defaults are updated
- **WHEN** Studio submits valid new generation defaults
- **THEN** the result and subsequent settings read SHALL reflect the updated defaults

#### Scenario: Default, clear, and unchanged are distinct
- **WHEN** Studio selects `default`, `clear`, or `unchanged`
- **THEN** the contract SHALL preserve their distinct intents without accepting a path value

#### Scenario: User confirms a replacement local path
- **WHEN** Studio submits `replace` with a non-empty NUL-free local configuration path and `confirmLocalPath: true`
- **THEN** the input SHALL authorize future strict server validation, and the result SHALL expose only redacted configured/display state

#### Scenario: Replacement lacks confirmation or result echoes the path
- **WHEN** `replace` lacks literal confirmation, another operation carries a path, or a result contains the submitted full path
- **THEN** shared input/output validation SHALL fail
