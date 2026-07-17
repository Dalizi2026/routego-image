## ADDED Requirements

### Requirement: Browser upload resources are session scoped and policy bounded
Upload reservation and binary-route metadata SHALL be relative, short-lived, session/origin protected, purpose bound, MIME restricted, and size bounded. Upload JSON, structured errors, diagnostics, and mock observations MUST NOT contain raw bytes, Base64, full local paths, provider credentials, authorization headers, cookies, or session-token values.

#### Scenario: Protected upload route is issued
- **WHEN** a valid upload reservation is created
- **THEN** the route descriptor SHALL require the current session and matching loopback origin and SHALL expose only relative routing and policy metadata

#### Scenario: Sensitive upload content reaches a diagnostic boundary
- **WHEN** an error or observation contains upload bytes, Base64, a token, credential, or staging path
- **THEN** redaction/output validation SHALL remove or reject the sensitive value before logging or serialization

### Requirement: Upload integrity, expiry, and consumption fail closed
The future upload owner MUST detect MIME from bytes, enforce maximum bytes while streaming, compute SHA-256, validate an expected checksum when present, record image dimensions when available, expire/discard resources, and enforce reusable-image versus single-consume-ZIP policy before Integration resolves any resource.

#### Scenario: Declared and detected MIME differ
- **WHEN** uploaded bytes do not match the purpose's allowed detected MIME policy
- **THEN** finalization SHALL fail with `upload_invalid_type` and the resource SHALL not be resolved for Creation or ZIP import

#### Scenario: Stream exceeds maximum bytes
- **WHEN** the binary route receives more than the reservation maximum
- **THEN** it SHALL stop accepting data, return `upload_oversize`, and dispose of incomplete staging safely

#### Scenario: Resource is expired, discarded, or consumed
- **WHEN** Integration attempts to resolve an upload after expiry/discard or a ZIP after its successful single consumption
- **THEN** resolution SHALL fail without revealing a storage path and without reusing bytes

### Requirement: Studio image and search DTOs are path and credential free
Studio generate/edit/batch inputs, results, events, errors, relationships, artifacts, Library search rows, and thumbnails SHALL contain only approved stable identifiers, metadata, and protected relative resources. They MUST NOT contain local paths, file URLs, unrestricted external URLs, provider credentials, request headers, image bytes, Base64, or data URLs.

#### Scenario: Public MCP artifact is projected to Studio
- **WHEN** Integration converts a path-based public/internal execution artifact into a Studio result
- **THEN** it SHALL replace path/display data with `artifactId` plus a protected `BrowserResourceDescriptor`

#### Scenario: Unsafe value crosses the Studio boundary
- **WHEN** a Studio DTO contains a path-like field, external URL, credential-like field, or encoded image payload
- **THEN** shared output validation and browser-safe audits SHALL fail

### Requirement: Output-directory replacement is explicitly confirmed and server validated
The only Studio contract allowed to carry a local configuration path SHALL be output-directory `replace` with literal user confirmation. The future server MUST canonicalize and strictly validate that path, reject relative/NUL/traversal/root/legacy-protected/unsafe-symlink/non-local destinations, and verify a safe user-controlled destination before persistence. Results and logs MUST NOT echo the full submitted path.

#### Scenario: Safe replacement is submitted
- **WHEN** the user explicitly confirms a candidate output directory
- **THEN** the future settings service SHALL validate it server-side before storing and SHALL return only redacted configured/display state

#### Scenario: Unsafe or unconfirmed path is submitted
- **WHEN** confirmation is absent or the path is relative, root-level, NUL-containing, traversal-like, legacy-protected, unsafe through symlink resolution, or not a safe local destination
- **THEN** the service SHALL reject it without changing settings or exposing sensitive path details

### Requirement: Legacy and real user data remain untouched
This corrective gate SHALL use only synthetic in-memory mock state and SHALL NOT read, mutate, import, delete, or migrate real configuration, credentials, upload bytes, user images, Library indexes, legacy plugin data, or legacy paths.

#### Scenario: Tests run in an environment containing real local data
- **WHEN** contract and mock tests execute on a developer machine
- **THEN** their outcome SHALL be independent of environment variables, home-directory files, network access, real keys, and user images
