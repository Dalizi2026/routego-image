# Shared Image Contracts Specification

## Purpose

Defines the shared runtime schemas and structured operation contracts used across Routego Image.

## Requirements
### Requirement: Runtime schemas are the shared contract source
The system SHALL define browser-safe Zod schemas and inferred TypeScript types as the single source of truth for public MCP, HTTP, Studio, and application-service request and result shapes.

#### Scenario: Valid boundary value
- **WHEN** an adapter receives a value that satisfies the shared schema
- **THEN** MCP, HTTP, Studio, and service code SHALL observe the same parsed structure and inferred type

#### Scenario: Invalid boundary value
- **WHEN** an adapter receives a value that violates a shared schema
- **THEN** the value SHALL be rejected before business logic or provider transport is invoked

### Requirement: Unified image operation validation
The image operation contract SHALL represent generate and edit requests, prompt text, up to 16 ordered references with roles and labels, one edit target, supporting images, an optional mask, edit invariants, size and ratio intent, quality, output format, compression, variant count, partial image preference, transparency mode, moderation, continuation identifiers, output destination, and library-save preference.

#### Scenario: Generate request with variants
- **WHEN** a generate request provides a non-empty prompt and a count from 1 through 4
- **THEN** the contract SHALL accept it as multiple variants of one prompt rather than a batch of independent assets

#### Scenario: Ambiguous edit request
- **WHEN** an edit request omits its target image or supplies a mask without a target image
- **THEN** the contract SHALL reject the request as invalid

#### Scenario: Reference limit exceeded
- **WHEN** a request contains more than 16 reference images
- **THEN** the contract SHALL reject it before any file read or provider request

#### Scenario: Invalid output control
- **WHEN** count, compression, quality, format, or another bounded output control is outside its supported contract range
- **THEN** the contract SHALL return a structured validation failure

### Requirement: Seven public operation contracts
The shared package SHALL define validated inputs and results for `routego_status`, `routego_generate`, `routego_edit`, `routego_batch`, `routego_search_library`, `routego_manage_library`, and `routego_open_studio`.

#### Scenario: Batch bounds
- **WHEN** a batch contains 1 through 20 independent operations and concurrency from 1 through 10
- **THEN** the batch input SHALL be accepted and preserve the order and identity of every item

#### Scenario: Invalid batch bounds
- **WHEN** a batch exceeds 20 items or requests concurrency outside 1 through 10
- **THEN** the batch input SHALL be rejected before task execution

#### Scenario: Tool and HTTP mappings
- **WHEN** an operation is exposed through MCP or loopback HTTP
- **THEN** both transports SHALL reference the same operation identifier and input/result schemas

### Requirement: Structured results and failures
Operation results SHALL include a request identifier, requested and effective parameters, explicit status, transport, attempt count, provider request count, output paths and image-display content when present, input/output relationships, partial/final artifacts, failed slots, `receivedAnyOutput`, `mayHaveBilled`, provider response/image identifiers when available, and structured sanitized errors.

#### Scenario: Partial batch success
- **WHEN** some batch items succeed and others fail
- **THEN** the result SHALL report an explicit partial status and a success or structured error for every item without claiming total success

#### Scenario: Degraded continuation
- **WHEN** continuous editing reuses the previous output because Responses state is unavailable
- **THEN** the result SHALL set `degradedContinuation` to true and preserve the new input/output relationship

### Requirement: Transport-neutral structured errors
The error contract SHALL expose a stable code/category, processing stage, safe user message, retry disposition, optional HTTP/provider code, optional capability identifier, partial artifacts, billing/output flags, and sanitized details without authentication data or image bytes.

#### Scenario: Capability unavailable
- **WHEN** no verified provider path can satisfy an image-input operation
- **THEN** the boundary SHALL return `capability_unavailable` and SHALL NOT fabricate a successful edit result

#### Scenario: Secret-bearing provider failure
- **WHEN** a provider error contains authorization headers, tokens, or image data
- **THEN** the structured error SHALL omit or redact those values before crossing MCP, HTTP, logs, or Studio boundaries

#### Scenario: Output received before failure
- **WHEN** a provider stream or multi-output response fails after returning an image
- **THEN** the error/result SHALL preserve the received artifact, set `receivedAnyOutput` and `mayHaveBilled` appropriately, and SHALL NOT present the operation as safely replayable

### Requirement: Browser-safe settings and provider profile contracts
The shared contract package SHALL define settings-read and provider-profile upsert, remove, and set-active schemas. API-key writes MUST use exactly one of `unchanged`, `replace`, or `clear`, and every settings or profile result SHALL expose only `hasApiKey` and optional `apiKeyPreview` secret metadata.

#### Scenario: Settings are read by Studio
- **WHEN** Studio reads configured provider profiles
- **THEN** the result SHALL include redacted endpoint/profile/default metadata and SHALL NOT contain an API key, authorization header, or credential-bearing URL component

#### Scenario: Existing API key is preserved
- **WHEN** a profile update specifies the `unchanged` API-key mutation
- **THEN** the input SHALL carry no key value and the result SHALL report only whether a key remains configured

#### Scenario: API key is replaced or cleared
- **WHEN** a profile update specifies `replace` with a non-empty value or specifies `clear` without a value
- **THEN** the schema SHALL distinguish the two operations and no result schema SHALL echo the supplied value

### Requirement: Separate model refresh and capability probe contracts
The shared package SHALL define a non-billable model-refresh operation separately from a potentially billable capability-probe operation. A capability probe MUST require `confirmBillableProbe: true` and SHALL report the probed capability/request shape, evidence outcome, and billing risk.

#### Scenario: Models are refreshed without generation
- **WHEN** Studio requests model refresh
- **THEN** the contract SHALL mark the operation non-billable and SHALL NOT authorize an image generation, edit, or Responses image request

#### Scenario: Billable probe lacks confirmation
- **WHEN** a capability-probe input omits explicit billable confirmation
- **THEN** shared validation SHALL reject it before provider transport is invoked

### Requirement: Folder listing and ordering contracts
The shared package SHALL define browser-safe folder descriptors, folder listing, and complete folder reordering schemas with stable identifiers, display order, asset counts, and structured failures.

#### Scenario: Folder order is changed
- **WHEN** Studio submits a complete ordered list of unique folder identifiers
- **THEN** the contract SHALL preserve the requested order and return the resulting browser-safe folder descriptors

#### Scenario: Folder order is ambiguous
- **WHEN** a reorder request repeats a folder identifier or omits required ordering entries reported by the service
- **THEN** validation or service output SHALL return a structured conflict instead of reporting success

### Requirement: Complete browser-safe asset detail contracts
The shared package SHALL define an asset-detail result containing stable asset/artifact identifiers, prompt and model metadata, requested and effective image parameters, execution metadata, structured errors, folder membership and deletion state, allowed actions, and ordered relationships using `source`, `target`, `reference`, `supporting`, `mask`, and `output` roles.

#### Scenario: Studio opens an asset detail
- **WHEN** an existing asset detail is requested
- **THEN** the result SHALL include complete generation/edit parameters, current folder state, allowed actions, errors when present, and enough ordered relationships to distinguish every source, target, reference, supporting image, mask, and output

#### Scenario: Detail is not available
- **WHEN** the requested asset does not exist or is not visible in the current state
- **THEN** the service SHALL return a structured `not_found` or access error and SHALL NOT fabricate detail data

### Requirement: Session-protected browser resource descriptors
The shared package SHALL define browser-resource requests and results using a session-scoped relative resource identifier or relative URL plus MIME type, dimensions, byte length, expiry, and cache metadata. The result MUST NOT expose an arbitrary local path, provider credential, or unrestricted external URL.

#### Scenario: Browser requests an image preview
- **WHEN** Studio requests a browser resource for an asset rendition
- **THEN** the result SHALL contain a relative protected resource URL/identifier and validated image metadata without a local filesystem path

#### Scenario: Unsafe resource descriptor is returned
- **WHEN** a service result contains an absolute local path, credential-bearing URL, or non-relative browser resource URL
- **THEN** output validation SHALL fail closed as an internal contract error

### Requirement: Preflighted Library mutation and partial-result contracts
The shared package SHALL define preflight and execution schemas for destructive, ZIP, and bulk Library mutations. Preflight SHALL describe required confirmations and per-item eligibility without mutation; execution SHALL require the preflight identifier and SHALL return an ordered success, failure, or skipped result for every requested item plus an explicit overall `succeeded`, `partial`, or `failed` status.

#### Scenario: Permanent deletion is reviewed
- **WHEN** Studio preflights permanent deletion for multiple assets
- **THEN** the result SHALL identify every eligible or blocked asset and require explicit permanent-delete confirmation before execution

#### Scenario: Batch mutation partially fails
- **WHEN** some requested assets are mutated and others fail validation or conflict
- **THEN** the execution result SHALL be `partial`, preserve each item outcome and structured error, and SHALL NOT claim total success

#### Scenario: ZIP import and export use protected resources
- **WHEN** Studio imports or exports a ZIP archive
- **THEN** the contract SHALL use a session-scoped upload/resource identifier and protected browser resource descriptor rather than an arbitrary browser-supplied local path
