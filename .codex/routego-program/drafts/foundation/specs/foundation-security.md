> 非权威草稿：等待两份审计最终报告后重新核对。不得用于 OpenSpec apply。

## ADDED Requirements

### Requirement: Recursive secret and image-data redaction
Diagnostics and mock observations SHALL recursively redact API keys, authorization and cookie headers, bearer values, session tokens, credential-bearing query parameters, and image data payloads without mutating the source value.

#### Scenario: Nested sensitive fields
- **WHEN** a diagnostic value contains sensitive fields at multiple object or array depths
- **THEN** every sensitive value SHALL be replaced with a non-secret marker and the original value SHALL remain unchanged

#### Scenario: Error message contains bearer token
- **WHEN** a provider or runtime error embeds a bearer token in free text
- **THEN** the safe diagnostic output SHALL redact the token before logging or returning the error

### Requirement: Loopback-only binding
Local HTTP and mock server configuration SHALL permit binding only to `127.0.0.1` or `::1` and SHALL reject wildcard, LAN, or public addresses.

#### Scenario: Valid loopback bind
- **WHEN** the service requests `127.0.0.1` or `::1`
- **THEN** the security policy SHALL accept the bind address

#### Scenario: Public bind rejected
- **WHEN** the service requests `0.0.0.0`, `::`, a LAN address, or a hostname resolving outside loopback
- **THEN** the security policy SHALL reject startup before a listener is created

### Requirement: Session and origin protection
Protected loopback HTTP operations SHALL require a cryptographically random short-lived session token, constant-time token comparison, and an allowed matching loopback origin without wildcard CORS or cookie authentication.

#### Scenario: Valid local request
- **WHEN** a request presents the current session token and an allowed loopback origin
- **THEN** the request SHALL pass the boundary authorization policy

#### Scenario: Missing or incorrect token
- **WHEN** a protected request omits the token or presents a different value
- **THEN** the request SHALL be rejected without revealing the expected token

#### Scenario: Cross-site request
- **WHEN** a request presents a non-loopback or mismatched origin even with a valid token
- **THEN** the request SHALL be rejected and no wildcard CORS permission SHALL be emitted

### Requirement: Non-destructive path containment
Path safety helpers SHALL reject NUL input, traversal outside an approved root, and ambiguous cross-root paths before later lanes access files, and SHALL never target legacy plugin/config/library paths for deletion or overwrite.

#### Scenario: Contained output path
- **WHEN** a normalized candidate path remains within its approved root
- **THEN** the helper SHALL return the resolved contained path

#### Scenario: Traversal attempt
- **WHEN** a candidate path escapes the approved root through relative segments, drive changes, UNC changes, or sibling-prefix confusion
- **THEN** the helper SHALL reject it before any filesystem mutation

#### Scenario: Legacy path supplied
- **WHEN** a destructive operation targets a legacy plugin, legacy configuration, or legacy image-library root
- **THEN** the safety policy SHALL reject the operation

### Requirement: Repository safety gate
The repository SHALL provide an automated safety check that fails on likely committed API keys, authentication headers, local configuration, user-image fixtures, generated image outputs, or test/report caches.

#### Scenario: Synthetic contract fixtures
- **WHEN** tests use explicitly synthetic identifiers or in-memory image payloads that cannot be mistaken for user data or credentials
- **THEN** the safety check SHALL allow them

#### Scenario: Secret-like tracked content
- **WHEN** a tracked source or fixture contains a likely real key or authorization header value
- **THEN** the safety check SHALL fail with a file location while avoiding echoing the full secret
