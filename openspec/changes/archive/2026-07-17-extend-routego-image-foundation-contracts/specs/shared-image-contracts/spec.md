## ADDED Requirements

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
