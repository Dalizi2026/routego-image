## MODIFIED Requirements

### Requirement: Unified image operation validation
The image operation contract SHALL represent generate and edit requests, prompt text, up to five ordered references with roles and labels, one required edit target, edit invariants, size and ratio intent, quality, output format, compression, variant count, partial image preference, transparency mode, moderation, output destination, and library-save preference. An edit SHALL contain exactly one target image and invariants with at least one allowed, preserved, or forbidden condition.

#### Scenario: Generate request with variants
- **WHEN** a generate request provides a non-empty prompt and a count from 1 through 4
- **THEN** the contract SHALL accept it as multiple variants of one prompt rather than a batch of independent assets

#### Scenario: Valid edit request
- **WHEN** an edit provides a target image, non-empty prompt, no more than five ordered references, and non-empty invariants
- **THEN** the contract SHALL accept it as an edit request without applying configured generation dimensions

#### Scenario: Ambiguous edit request
- **WHEN** an edit request omits its target image or supplies no allowed, preserved, or forbidden edit condition
- **THEN** the contract SHALL reject the request as invalid

#### Scenario: Reference limit exceeded
- **WHEN** a request contains more than five reference images
- **THEN** the contract SHALL reject it before any file read or provider request

#### Scenario: Invalid output control
- **WHEN** count, compression, quality, format, or another bounded output control is outside its supported contract range
- **THEN** the contract SHALL return a structured validation failure

### Requirement: Eight public operation contracts
The shared package SHALL define validated inputs and results for `routego_status`, `routego_generate`, `routego_edit`, `routego_prepare_regeneration`, `routego_batch`, `routego_search_library`, `routego_manage_library`, and `routego_open_studio`.

#### Scenario: Direct edit mapping
- **WHEN** an edit operation is exposed through MCP or loopback HTTP
- **THEN** both transports SHALL use the same `routego_edit` identifier and shared edit input/result schemas

#### Scenario: Batch bounds
- **WHEN** a batch contains 1 through 20 independent generation operations and concurrency from 1 through 10
- **THEN** the batch input SHALL be accepted and preserve the order and identity of every item

#### Scenario: Invalid batch bounds
- **WHEN** a batch exceeds 20 items, requests concurrency outside 1 through 10, or contains an edit operation
- **THEN** the batch input SHALL be rejected before task execution

#### Scenario: Tool and HTTP mappings
- **WHEN** an operation is exposed through MCP or loopback HTTP
- **THEN** both transports SHALL reference the same operation identifier and input/result schemas
