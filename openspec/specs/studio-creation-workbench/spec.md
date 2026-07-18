# Studio Creation Workbench Specification

## Purpose

Defines the path-free generation, editing, upload, capability-gating, result, batch, retry, and continuation requirements for the Routego Studio workbench.

## Requirements

### Requirement: Complete creation controls
The workbench SHALL support text generation and path-free editing with prompt, ordered references, one edit target, supporting images, invariants, size, aspect ratio, quality, format, compression, variant count, partial-image preference, transparency, moderation, continuation, and save-to-Library controls using the frozen Studio schemas.

#### Scenario: Text-only generation
- **WHEN** the user submits a valid prompt and output controls without image inputs
- **THEN** Studio SHALL send a `studioGenerate` request and render the validated effective parameters and result

#### Scenario: Invalid control combination
- **WHEN** the user selects PNG compression, non-PNG transparency, missing edit invariants, too many inputs, or another invalid combination
- **THEN** Studio SHALL show field-level guidance and SHALL NOT dispatch the operation

### Requirement: Path-free file upload lifecycle
Reference, target, supporting, mask, and ZIP files SHALL use reserve, protected binary upload, finalize, status, retry, and discard operations. Studio MUST NOT serialize a local path, Base64 image, credential, or raw bytes into JSON.

#### Scenario: Reference image is dropped
- **WHEN** a permitted image file is dropped into a confirmed reference control
- **THEN** Studio SHALL reserve the correct purpose, upload bytes to the returned relative route, finalize the resource, and keep only the `uploadResourceId` in the request draft

#### Scenario: Upload fails or expires
- **WHEN** reservation, binary upload, finalization, or later status fails
- **THEN** Studio SHALL show the structured upload failure, preserve other form work, and offer only safe retry/remove actions without claiming the file is ready

### Requirement: Provider capability gating
Studio SHALL gate image input, multi-image input, target editing, mask editing, Responses continuation, output controls, and native transparency by scoped capability evidence. `unknown` and `unsupported` SHALL disable the dependent submission path and display “当前中转未确认支持”; `degraded` SHALL explain the weaker workflow before use.

#### Scenario: Capability is unknown
- **WHEN** image input or edit capability has no conclusive evidence
- **THEN** affected controls SHALL be disabled or read-only with the required message and Studio SHALL NOT fabricate an edit request

#### Scenario: Capability is supported or degraded
- **WHEN** a confirmed probe returns supported evidence or an explicitly usable degraded route
- **THEN** Studio SHALL enable only the covered controls and SHALL display degradation details when semantics are weaker

### Requirement: Honest creation outcomes
Studio SHALL render succeeded, partial, failed, and degraded creation results with protected artifacts, requested/effective parameters, relationships, failed slots, billing/output flags, and structured errors. It MUST NOT display a failed or unavailable operation as successful.

#### Scenario: Partial output is returned
- **WHEN** a creation result contains partial artifacts and a failure
- **THEN** Studio SHALL preserve and label the partial images, show billing/output risk, and avoid presenting automatic safe replay

#### Scenario: Capability unavailable
- **WHEN** `studioEdit` or an image-input request returns `capability_unavailable`
- **THEN** Studio SHALL show the limitation, keep the draft, and SHALL NOT manufacture a local edit result

### Requirement: Ordered batch workflows
The workbench SHALL allow 1 through 20 ordered path-free tasks with concurrency 1 through 10 and SHALL preserve stable task identity, order, per-item state, and overall partial/failure status.

#### Scenario: Mixed batch completes
- **WHEN** batch items succeed, partially succeed, and fail
- **THEN** Studio SHALL keep the submitted order, show one honest outcome for every item, and label the batch partial

#### Scenario: Batch is invalid
- **WHEN** task IDs repeat, limits are exceeded, or an item draft is invalid
- **THEN** Studio SHALL block batch dispatch and identify the affected task

### Requirement: Retry and edit handoff
Creation and Library results SHALL support retry and edit handoff using stable asset, artifact, or upload identifiers while preserving relevant prompt, controls, and invariants without exposing filesystem paths.

#### Scenario: Result is edited again
- **WHEN** the user chooses edit on an eligible result
- **THEN** Studio SHALL open an edit draft with that result as the target locator and SHALL reapply current capability gates before submission

