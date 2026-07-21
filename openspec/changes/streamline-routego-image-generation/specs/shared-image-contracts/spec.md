## MODIFIED Requirements

### Requirement: Unified image operation validation
The image operation contract SHALL represent generation requests with non-empty prompt text, zero through five ordered reference images with roles and labels, size and ratio intent, quality, output format, compression, variant count, partial-image preference, transparency mode, moderation, output destination, and Library-save preference. It MUST NOT accept edit targets, masks, edit invariants, edit actions, or continuation identifiers.

#### Scenario: Generate request with variants
- **WHEN** a generate request provides a non-empty prompt and a count from 1 through 4
- **THEN** the contract SHALL accept it as multiple variants of one prompt rather than a batch of independent assets

#### Scenario: Reference limit exceeded
- **WHEN** a request contains more than five reference images
- **THEN** the contract SHALL reject it before any file read, capability probe, or provider request

#### Scenario: Removed edit field is supplied
- **WHEN** a request supplies a target, mask, invariant, edit action, or continuation identifier
- **THEN** strict validation SHALL reject the unknown edit field before execution

#### Scenario: Invalid output control
- **WHEN** count, compression, quality, format, or another bounded output control is outside its supported contract range
- **THEN** the contract SHALL return a structured validation failure

### Requirement: Seven public operation contracts
The shared package SHALL define validated inputs and results for `routego_status`, `routego_generate`, `routego_batch`, `routego_search_library`, `routego_manage_library`, `routego_open_studio`, and `routego_prepare_regeneration`. `routego_edit` SHALL NOT be registered or accepted.

#### Scenario: Generation-only batch bounds
- **WHEN** a batch contains 1 through 20 independent generation operations
- **THEN** the batch input SHALL be accepted and preserve the order and identity of every item while using fixed concurrency two

#### Scenario: Invalid batch operation
- **WHEN** a batch item requests edit behavior, the batch exceeds 20 items, or the caller supplies a concurrency override
- **THEN** the batch input SHALL be rejected before task execution

#### Scenario: Tool and HTTP mappings
- **WHEN** an operation is exposed through MCP or loopback HTTP
- **THEN** both transports SHALL reference the same operation identifier and input/result schemas

#### Scenario: Removed tool is invoked
- **WHEN** a caller attempts to invoke `routego_edit`
- **THEN** the runtime SHALL return an unknown-tool or not-found response without provider or Library mutation

### Requirement: Complete path-free Studio creation parameters
Studio generation contracts SHALL cover non-empty prompt text, size, aspect ratio, format, count from 1 through 4, transparency, and Library-save preference. Studio generation MUST NOT accept image inputs, edit fields, quality, compression, partial-image, moderation, or continuation controls from the workbench; hidden configured defaults MAY be resolved by the service after validation.

#### Scenario: Text-only generate uses approved controls
- **WHEN** Studio submits a non-empty text-only request using the five approved control groups
- **THEN** the request SHALL parse without requiring a local output directory or image locator

#### Scenario: Removed Studio field is supplied
- **WHEN** Studio submits an image locator, edit field, or removed advanced workbench field
- **THEN** strict validation SHALL reject it before resource resolution or provider execution

#### Scenario: Transparency conflicts with format
- **WHEN** transparency is enabled with JPEG or WebP
- **THEN** validation SHALL reject the unresolved conflicting combination rather than silently changing the submitted contract

### Requirement: Ordered path-free Studio batch contracts
Studio batch SHALL accept 1 through 20 unique ordered generation task IDs, use fixed concurrency two, preserve one path-free result for every input task in the same order, and report overall `succeeded`, `partial`, or `failed` consistently with item outcomes. Each item SHALL own prompt, size, aspect ratio, and count; format and transparency SHALL be snapshotted from global controls at submission.

#### Scenario: Mixed batch partially succeeds
- **WHEN** ordered Studio generation tasks produce successes and failures
- **THEN** the batch result SHALL be `partial`, preserve task order, and include one honest result or error for every task

#### Scenario: Global controls are snapshotted
- **WHEN** a batch is submitted and the user later changes format, transparency, provider, or model
- **THEN** every submitted item SHALL retain its submission-time values and later drafts SHALL use the new values

#### Scenario: Batch bounds or identity are invalid
- **WHEN** Studio exceeds task limits, repeats a task ID, includes edit behavior, or supplies a concurrency override
- **THEN** input validation SHALL fail before execution

## REMOVED Requirements

### Requirement: Path-free Studio image input references
**Reason**: Studio is now text-generation-only and no longer accepts reference, target, supporting, or mask uploads.
**Migration**: Use zero through five safe image references with `routego_generate` in the Codex conversation; remove Studio image input drafts during the local schema upgrade.
