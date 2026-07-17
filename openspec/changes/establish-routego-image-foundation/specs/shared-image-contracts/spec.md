## ADDED Requirements

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
