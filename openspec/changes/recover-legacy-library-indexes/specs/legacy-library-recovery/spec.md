## ADDED Requirements

### Requirement: Legacy Library upgrade is explicit and recoverable
The system SHALL inspect a version-1 Library index without mutation and SHALL return a path-free migration state. It SHALL convert only a complete, validated generation-only subset to version 2 after the user supplies the exact current confirmation fingerprint. The migration SHALL create a recovery copy, preserve every supported blob and logical record, use the Library lock and atomic replacement, and verify the promoted index before reporting success. It MUST NOT perform a provider request.

#### Scenario: Compatible version-1 Library is found
- **WHEN** Studio opens a Library with only convertible version-1 generation records
- **THEN** it SHALL receive a ready migration state with a deterministic fingerprint and zero provider requests, while the original index remains unchanged until confirmation

#### Scenario: Confirmation promotes a compatible index
- **WHEN** the user confirms the current ready fingerprint
- **THEN** the service SHALL create a recovery copy, atomically promote a validated version-2 index, preserve the referenced bytes and records, and resume normal Library recovery without a provider request

#### Scenario: Legacy data is not safely convertible
- **WHEN** a version-1 index contains edit, deleted, malformed, or unsupported records
- **THEN** the service SHALL return a blocked path-free migration state and SHALL not overwrite, delete, reset, or partially convert the index

#### Scenario: Confirmation becomes stale
- **WHEN** the index changes after preflight and before confirmation
- **THEN** the service SHALL reject the stale confirmation without changing the index or blobs

### Requirement: Legacy migration information is redacted and private
The system SHALL expose legacy migration state only through authenticated Studio-local contracts. It MUST NOT add a public MCP operation, reveal an index or backup path, provider credential, raw image bytes, or a user image in a result, error, log, or browser state.

#### Scenario: A non-Studio caller attempts migration
- **WHEN** an unauthenticated request or MCP tool call attempts to read or execute legacy migration
- **THEN** the system SHALL reject it before reading or mutating Library data

